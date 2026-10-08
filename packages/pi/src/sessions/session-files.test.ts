import { createTempDir, parseFixture, present } from "@atrium/testkit";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, chmod, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import { createSessionFileReader, sessionFolder, sessionsLocation } from "./session-files";

/**
 * A temporary directory removed after the test.
 *
 * @remarks
 * Real files, as the reader reads them.
 *
 * @sideEffects Creates the directory.
 * @param prefix - Readable prefix.
 * @returns Its path.
 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  onTestFinished(dir.cleanup);
  return dir.path;
}

/**
 * The lines of the session file pi wrote in the recorded history scenario.
 *
 * @remarks
 * A real file, so the reader is checked against what pi writes.
 *
 * @sideEffects Reads the fixture.
 * @returns The lines.
 */
function recordedSessionLines(): string[] {
  const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", "history.jsonl"), "utf8"));
  const session = present(
    fixture.find((record) => record.kind === "session"),
    "the recorded session file",
  );
  return (session as unknown as { lines: unknown[] }).lines.map((line) => JSON.stringify(line));
}

/**
 * The text of a session file: one record per line, each ended by LF, as pi writes them.
 *
 * @remarks
 * Strings are taken as lines already serialized.
 *
 * @sideEffects none
 * @param lines - Records or lines.
 * @returns The text.
 */
function text(lines: unknown[]): string {
  return lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");
}

/**
 * Writes a session file, changed at `modifiedAt` seconds since the epoch.
 *
 * @remarks
 * A fixed time lets tests tell a rewrite from an unchanged file.
 *
 * @sideEffects Creates the folder and file.
 * @param folder - The folder.
 * @param name - The file name.
 * @param lines - Its records.
 * @param modifiedAt - Its modification time, in seconds.
 * @returns The file's path.
 */
async function sessionFile(folder: string, name: string, lines: unknown[], modifiedAt = 100): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, text(lines));
  await utimes(path, modifiedAt, modifiedAt);
  return path;
}

/**
 * A session header.
 *
 * @remarks
 * pi's version 3 header.
 *
 * @sideEffects none
 * @param id - The session id.
 * @param cwd - The working directory.
 * @returns The header.
 */
function header(id: string, cwd = "/work") {
  return { type: "session", version: 3, id, timestamp: "2026-10-08T00:00:00.000Z", cwd };
}

/**
 * A user message entry.
 *
 * @remarks
 * `content` as pi writes it: a string or blocks.
 *
 * @sideEffects none
 * @param content - The content.
 * @returns The entry.
 */
function user(content: unknown) {
  return {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp: "2026-10-08T00:00:00.000Z",
    message: { role: "user", content, timestamp: 0 },
  };
}

/**
 * A `session_info` entry.
 *
 * @remarks
 * How pi records the session's name.
 *
 * @sideEffects none
 * @param name - The name.
 * @returns The entry.
 */
function info(name: unknown) {
  return { type: "session_info", id: "e5f6a7b8", parentId: null, timestamp: "2026-10-08T00:00:00.000Z", name };
}

/**
 * Scans a folder once with a new reader.
 *
 * @remarks
 * For tests about one scan.
 *
 * @sideEffects Reads the folder.
 * @param folder - The folder.
 * @returns What it found.
 */
function scanOnce(folder: string) {
  return createSessionFileReader().scanFolder(folder);
}

/**
 * How many files this process has open.
 *
 * @remarks
 * Each holds a descriptor until it is closed.
 *
 * @sideEffects Reads `/dev/fd`.
 * @returns The count.
 */
function openFiles(): number {
  return readdirSync("/dev/fd").length;
}

describe("SessionFileReader.scanFolder", () => {
  it("reads the session id, working directory, name and first question of a file pi wrote", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "2026-10-08_x.jsonl", recordedSessionLines(), 1_000);

    expect(await scanOnce(folder)).toStrictEqual([
      { path, sessionId: "<uuid-1>", cwd: "<cwd>", name: null, firstPrompt: "one", modifiedAt: 1_000_000 },
    ]);
  });

  it("names the session by its latest session_info, trimmed, and an empty or odd one clears it", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [header("a"), info("first"), user("hi"), info("  second  ")]);
    await sessionFile(folder, "b.jsonl", [header("b"), info("named"), info("   ")]);
    await sessionFile(folder, "c.jsonl", [header("c"), info("named"), info(7)]);
    await sessionFile(folder, "d.jsonl", [header("d"), user('mentions "session_info"'), { type: "label", name: "x" }]);

    const found = await scanOnce(folder);

    expect(found.map((file) => [file.sessionId, file.name, file.firstPrompt])).toStrictEqual([
      ["a", "second", "hi"],
      ["b", null, null],
      ["c", null, null],
      ["d", null, 'mentions "session_info"'],
    ]);
  });

  it("finds the first question with text among records of every shape, joining text blocks", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "s.jsonl", [
      header("s1"),
      "null",
      "[]",
      '"user"',
      "not json but says user",
      { type: "message", message: null },
      { type: "message", message: "user" },
      { type: "message", message: { content: "no role" } },
      { type: "message", message: { role: "assistant", content: "not a user" } },
      { type: "other", message: { role: "user", content: "not a message entry" } },
      user([null, "x", 3, { type: "text" }, { type: "text", text: 4 }, { text: "no type" }, { type: "image" }]),
      user(7),
      user([
        { type: "text", text: "look" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "here" },
      ]),
      user("later"),
    ]);

    expect((await scanOnce(folder))[0]?.firstPrompt).toBe("look\nhere");
  });

  it("leaves out files whose first line is not a session header", async () => {
    const folder = await tempDir("sessions");
    const firsts = [
      "null",
      "[]",
      '"session"',
      "7",
      "{}",
      '{"type":"session"}',
      '{"type":"session","id":7}',
      "not json",
    ];
    for (const [index, first] of firsts.entries()) {
      await sessionFile(folder, `${index}.jsonl`, [first, user("hi")]);
    }
    await sessionFile(folder, "empty.jsonl", []);
    await sessionFile(folder, "z.jsonl", [header("s1"), user("hi")]);

    expect((await scanOnce(folder)).map((file) => file.sessionId)).toStrictEqual(["s1"]);
  });

  it("skips a broken link, a folder named like a session, other files, and a missing or locked folder", async () => {
    const dir = await tempDir("sessions");
    const folder = join(dir, "--work--");
    await sessionFile(folder, "good.jsonl", [header("s1"), user("hi")]);
    await sessionFile(folder, "notes.txt", [header("s9")]);
    await symlink(join(dir, "nowhere.jsonl"), join(folder, "broken.jsonl"));
    await mkdir(join(folder, "folder.jsonl"));
    const locked = join(dir, "--locked--");
    await sessionFile(locked, "hidden.jsonl", [header("s2"), user("x")]);
    await chmod(locked, 0o000);
    onTestFinished(() => chmod(locked, 0o755));
    const reader = createSessionFileReader();

    expect((await reader.scanFolder(folder)).map((file) => file.sessionId)).toStrictEqual(["s1"]);
    expect(await reader.scanFolder(join(dir, "missing"))).toStrictEqual([]);
    expect(await reader.scanFolder(locked)).toStrictEqual([]);
  });

  it("splits lines at LF only, so a lone CR between records does not end a line", async () => {
    const folder = await tempDir("sessions");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "a.jsonl"),
      `${JSON.stringify(header("s1"))}\n${JSON.stringify(user("one"))}\r${JSON.stringify(user("two"))}\n`,
    );

    // Joined at the CR the two records are one line that is not JSON, so neither counts.
    expect((await scanOnce(folder))[0]?.firstPrompt).toBeNull();
  });

  it("gives a header without a working directory an empty one", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [{ type: "session", id: "s1" }, user("hi")]);

    expect((await scanOnce(folder))[0]?.cwd).toBe("");
  });

  it("reads a file larger than one chunk, with a record across the chunk boundary", async () => {
    const folder = await tempDir("sessions");
    const padding = { type: "custom", id: "p", parentId: null, timestamp: "", data: "x".repeat(1024 * 1024 - 300) };
    await sessionFile(folder, "a.jsonl", [header("s1"), padding, user("across the boundary"), info("big")]);

    expect((await scanOnce(folder)).map((file) => [file.firstPrompt, file.name])).toStrictEqual([
      ["across the boundary", "big"],
    ]);
  });

  it("stops once its signal is aborted", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [header("s1"), user("hi")]);
    const reason = new Error("closing");

    await expect(createSessionFileReader().scanFolder(folder, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it("closes every file it opens", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [header("s1"), user("hi")]);
    const before = openFiles();

    await scanOnce(folder);
    await scanOnce(folder);

    expect(openFiles()).toBe(before);
  });

  it("passes on errors that are not the file system's", async () => {
    await expect(scanOnce(7 as unknown as string)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  });
});

describe("SessionFileReader across scans", () => {
  it("reads only what was appended to a file that grew", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "a.jsonl", [header("s1"), user("first")]);
    const reader = createSessionFileReader();
    await reader.scanFolder(folder);

    // The earlier bytes change without changing length; a reader that started over would see it.
    await writeFile(path, text([header("s1"), user("FIRST")]));
    await appendFile(path, text([info("named later")]));

    expect((await reader.scanFolder(folder)).map((file) => [file.firstPrompt, file.name])).toStrictEqual([
      ["first", "named later"],
    ]);
  });

  it("does not read a file again that kept its size and modification time", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "a.jsonl", [header("s1"), user("first")], 100);
    const reader = createSessionFileReader();
    await reader.scanFolder(folder);

    await sessionFile(folder, "a.jsonl", [header("s1"), user("FIRST")], 100);

    expect((await reader.scanFolder(folder)).map((file) => [file.path, file.firstPrompt])).toStrictEqual([
      [path, "first"],
    ]);
  });

  it.each([
    ["shrank", [header("s1"), user("hi")], 100],
    ["changed without growing", [header("s1"), user("FIRSTX")], 200],
  ])("reads a file again from its start when it %s", async (_case, lines, modifiedAt) => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [header("s1"), user("first!")], 100);
    const reader = createSessionFileReader();
    await reader.scanFolder(folder);

    await sessionFile(folder, "a.jsonl", lines, modifiedAt);

    expect((await reader.scanFolder(folder)).map((file) => file.firstPrompt)).toStrictEqual([
      (lines[1] as { message: { content: string } }).message.content,
    ]);
  });

  it("counts a record once its line break is written", async () => {
    const folder = await tempDir("sessions");
    await mkdir(folder, { recursive: true });
    const path = join(folder, "a.jsonl");
    const record = JSON.stringify(user("hi"));
    await writeFile(path, `${JSON.stringify(header("s1"))}\n${record.slice(0, 20)}`);
    const reader = createSessionFileReader();

    expect((await reader.scanFolder(folder)).map((file) => file.firstPrompt)).toStrictEqual([null]);
    await appendFile(path, `${record.slice(20)}\n`);
    expect((await reader.scanFolder(folder)).map((file) => file.firstPrompt)).toStrictEqual(["hi"]);
  });

  it("waits for a header still being written", async () => {
    const folder = await tempDir("sessions");
    await mkdir(folder, { recursive: true });
    const path = join(folder, "a.jsonl");
    const first = JSON.stringify(header("s1"));
    await writeFile(path, first.slice(0, 10));
    const reader = createSessionFileReader();

    expect(await reader.scanFolder(folder)).toStrictEqual([]);
    await appendFile(path, `${first.slice(10)}\n`);
    expect((await reader.scanFolder(folder)).map((file) => file.sessionId)).toStrictEqual(["s1"]);
  });

  it("forgets a file that went away, and reads a new one at the same path whole", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "a.jsonl", [header("s1"), user("first")], 100);
    const reader = createSessionFileReader();
    await reader.scanFolder(folder);

    await rm(path);
    expect(await reader.scanFolder(folder)).toStrictEqual([]);
    await sessionFile(folder, "a.jsonl", [header("s2"), user("again")], 100);

    expect((await reader.scanFolder(folder)).map((file) => [file.sessionId, file.firstPrompt])).toStrictEqual([
      ["s2", "again"],
    ]);
  });

  it("keeps what it read of other folders while it scans one", async () => {
    const dir = await tempDir("sessions");
    const pathA = await sessionFile(join(dir, "a"), "s.jsonl", [header("s1"), user("first")], 100);
    await sessionFile(join(dir, "b"), "s.jsonl", [header("s2"), user("other")], 100);
    const reader = createSessionFileReader();
    await reader.scanFolder(join(dir, "a"));
    await reader.scanFolder(join(dir, "b"));

    await sessionFile(join(dir, "a"), "s.jsonl", [header("s1"), user("FIRST")], 100);

    expect(await reader.scanFolder(join(dir, "a"))).toMatchObject([{ path: pathA, firstPrompt: "first" }]);
  });
});

describe("sessionFolder", () => {
  it("names a working directory's folder as pi does", () => {
    const location = { directory: "/pi/sessions", perCwd: true };

    expect(sessionFolder(location, "/Users/a/my-app")).toBe("/pi/sessions/--Users-a-my-app--");
    expect(sessionFolder(location, "C:\\work\\app")).toBe("/pi/sessions/--C--work-app--");
    expect(sessionFolder(location, "\\\\server\\share")).toBe("/pi/sessions/---server-share--");
  });

  it("uses the configured directory itself for every working directory", () => {
    expect(sessionFolder({ directory: "/elsewhere", perCwd: false }, "/Users/a/app")).toBe("/elsewhere");
  });
});

describe("sessionsLocation", () => {
  it("uses pi's session directory variable first, expanding ~, with no folder per directory", async () => {
    expect(await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "~/s" })).toStrictEqual({
      directory: "/home/a/s",
      perCwd: false,
    });
    expect(await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "/abs" })).toStrictEqual({
      directory: "/abs",
      perCwd: false,
    });
    expect(await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "~" })).toStrictEqual({
      directory: "/home/a",
      perCwd: false,
    });
  });

  it("uses sessionDir from pi's global settings next, then sessions in pi's agent directory", async () => {
    const agent = await tempDir("agent");
    const fallback = { directory: join(agent, "sessions"), perCwd: true };
    expect(await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toStrictEqual(fallback);

    await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/elsewhere" }));
    expect(
      await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: "" }),
    ).toStrictEqual({ directory: "/home/a/elsewhere", perCwd: false });

    for (const settings of [
      JSON.stringify({ sessionDir: "" }),
      "{ not json",
      JSON.stringify(["sessionDir"]),
      "null",
      '"text"',
      JSON.stringify({ sessionDir: 7 }),
    ]) {
      await writeFile(join(agent, "settings.json"), settings);
      expect(await sessionsLocation({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toStrictEqual(fallback);
    }
  });

  it("defaults to ~/.pi/agent/sessions, with the agent directory variable expanded too", async () => {
    expect(await sessionsLocation({ HOME: "/nowhere/home" })).toStrictEqual({
      directory: "/nowhere/home/.pi/agent/sessions",
      perCwd: true,
    });
    expect((await sessionsLocation({ HOME: "/nowhere/home", PI_CODING_AGENT_DIR: "" })).directory).toBe(
      "/nowhere/home/.pi/agent/sessions",
    );
    expect((await sessionsLocation({ HOME: "/nowhere/home", PI_CODING_AGENT_DIR: "~/agent" })).directory).toBe(
      "/nowhere/home/agent/sessions",
    );
  });
});

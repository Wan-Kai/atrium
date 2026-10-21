import { createTempDir, parseFixture, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, chmod, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import {
  createSessionFileReader,
  readUserImage,
  sessionDirectories,
  sessionFolder,
  sessionsLocation,
} from "./session-files";

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
 * A `model_change` entry.
 *
 * @remarks
 * How pi records the model a session switched to.
 *
 * @sideEffects none
 * @param provider - The provider's id.
 * @param modelId - The model's id there.
 * @returns The entry.
 */
function modelChange(provider: unknown, modelId: unknown) {
  return { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-08T00:00:00.000Z", provider, modelId };
}

/**
 * A `thinking_level_change` entry.
 *
 * @remarks
 * How pi records the level a session thinks at.
 *
 * @sideEffects none
 * @param thinkingLevel - The level.
 * @returns The entry.
 */
function levelChange(thinkingLevel: unknown) {
  return {
    type: "thinking_level_change",
    id: "l1",
    parentId: null,
    timestamp: "2026-10-08T00:00:00.000Z",
    thinkingLevel,
  };
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
  it("reads the session id, working directory, name, first question and model of a file pi wrote", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "2026-10-08_x.jsonl", recordedSessionLines(), 1_000);

    expect(await scanOnce(folder)).toStrictEqual([
      {
        path,
        sessionId: "<uuid-1>",
        cwd: "<cwd>",
        name: null,
        firstPrompt: "one",
        model: { providerId: "faux", modelId: "faux-1" },
        thinkingLevel: "medium",
        modifiedAt: 1_000_000,
      },
    ]);
  });

  it("names the session by its latest session_info, trimmed, and an empty or odd one clears it", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [header("a"), info("first"), user("hi"), info("  second  ")]);
    await sessionFile(folder, "b.jsonl", [header("b"), info("named"), info("   ")]);
    await sessionFile(folder, "c.jsonl", [header("c"), info("named"), info(7)]);
    await sessionFile(folder, "d.jsonl", [header("d"), user('mentions "session_info"'), { type: "label", name: "x" }]);
    // An entry of another type that holds the word "session_info" leaves the name alone.
    await sessionFile(folder, "e.jsonl", [
      header("e"),
      info("kept"),
      { type: "custom", customType: "audit", data: { seen: "session_info" } },
    ]);

    const found = await scanOnce(folder);

    expect(found.map((file) => [file.sessionId, file.name, file.firstPrompt])).toStrictEqual([
      ["a", "second", "hi"],
      ["b", null, null],
      ["c", null, null],
      ["d", null, 'mentions "session_info"'],
      ["e", "kept", null],
    ]);
  });

  it("reads the model and thinking level from the latest model_change and thinking_level_change", async () => {
    const folder = await tempDir("sessions");
    await sessionFile(folder, "a.jsonl", [
      header("a"),
      modelChange("openai-codex", "gpt-6.1-sol"),
      levelChange("off"),
      user("hi"),
      modelChange("anthropic", "claude-opus-5-5"),
      levelChange("high"),
    ]);
    await sessionFile(folder, "b.jsonl", [header("b"), user("no entries")]);
    await sessionFile(folder, "c.jsonl", [
      header("c"),
      modelChange("faux", "faux-1"),
      modelChange(7, "x"),
      levelChange(3),
    ]);
    await sessionFile(folder, "d.jsonl", [
      header("d"),
      modelChange("faux", "faux-1"),
      { type: "custom", customType: "audit", data: { seen: "model_change thinking_level_change" } },
    ]);

    const found = await scanOnce(folder);

    expect(found.map((file) => [file.sessionId, file.model, file.thinkingLevel])).toStrictEqual([
      ["a", { providerId: "anthropic", modelId: "claude-opus-5-5" }, "high"],
      ["b", null, null],
      ["c", { providerId: "faux", modelId: "faux-1" }, null],
      ["d", { providerId: "faux", modelId: "faux-1" }, null],
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

  it("takes what followed a skill's name as the first question, or the skill's name when nothing did", async () => {
    const folder = await tempDir("sessions");
    const skill = '<skill name="review" location="/skills/review/SKILL.md">\nRead the diff.\n</skill>';
    await sessionFile(folder, "a.jsonl", [header("a"), user(`${skill}\n\n the tests `)]);
    await sessionFile(folder, "b.jsonl", [header("b"), user(skill)]);

    expect((await scanOnce(folder)).map((file) => [file.sessionId, file.firstPrompt])).toStrictEqual([
      ["a", "the tests"],
      ["b", "review"],
    ]);
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
      '{"type":"message","id":"s0"}',
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

  it("reads a file again from its start after a scan that could not read it", async () => {
    const folder = await tempDir("sessions");
    const path = await sessionFile(folder, "a.jsonl", [header("s1"), user("first")], 100);
    const reader = createSessionFileReader();
    await reader.scanFolder(folder);

    // While it cannot be read, it may change in any way, not only grow.
    await sessionFile(folder, "a.jsonl", [header("s1"), user("FIRST"), info("named")], 200);
    await chmod(path, 0o000);
    onTestFinished(() => chmod(path, 0o644));
    expect(await reader.scanFolder(folder)).toStrictEqual([]);
    await chmod(path, 0o644);

    expect((await reader.scanFolder(folder)).map((file) => [file.firstPrompt, file.name])).toStrictEqual([
      ["FIRST", "named"],
    ]);
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

/**
 * A message entry with an id of its own.
 *
 * @remarks
 * For files with more than one message, each found by its id.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param role - Whose message.
 * @param content - Its content.
 * @returns The entry.
 */
function message(id: string, role: string, content: unknown) {
  return { ...user(content), id, message: { role, content, timestamp: 0 } };
}

/**
 * An image block, as pi keeps one in a message.
 *
 * @sideEffects none
 * @param mimeType - Its format.
 * @param data - Its base64.
 * @returns The block.
 */
function image(mimeType: unknown, data: unknown) {
  return { type: "image", mimeType, data };
}

describe("readUserImage", () => {
  it("reads a user message's image by its entry and its place among the message's images", async () => {
    const path = await sessionFile(await tempDir("images"), "s.jsonl", [
      header("s1"),
      message("00000001", "user", [{ type: "text", text: "下一条是 00000002" }, image("image/png", "b3RoZXI=")]),
      message("00000002", "user", [
        { type: "text", text: "看看 00000001" },
        image("image/png", "Zmlyc3Q="),
        { type: "text", text: "还有" },
        image("image/webp", "c2Vjb25k"),
      ]),
    ]);

    await expect(
      Promise.all([
        readUserImage(path, "00000002", 0),
        readUserImage(path, "00000002", 1),
        readUserImage(path, "00000002", 2),
      ]),
    ).resolves.toStrictEqual([
      { mimeType: "image/png", data: "Zmlyc3Q=" },
      { mimeType: "image/webp", data: "c2Vjb25k" },
      null,
    ]);
  });

  it("reads every format pi keeps and nothing else", async () => {
    const formats = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", 7];
    const path = await sessionFile(await tempDir("images"), "s.jsonl", [
      header("s1"),
      message(
        "00000001",
        "user",
        formats.map((format) => image(format, "eA==")),
      ),
    ]);

    const read = await Promise.all(formats.map((_, index) => readUserImage(path, "00000001", index)));

    expect(read).toStrictEqual([
      { mimeType: "image/png", data: "eA==" },
      { mimeType: "image/jpeg", data: "eA==" },
      { mimeType: "image/gif", data: "eA==" },
      { mimeType: "image/webp", data: "eA==" },
      null,
      null,
    ]);
  });

  it("finds nothing in a message that is not the user's, without data, in text only, not in the file, or in no file", async () => {
    const folder = await tempDir("images");
    const path = await sessionFile(folder, "s.jsonl", [
      header("s1"),
      message("00000001", "assistant", [image("image/png", "eA==")]),
      message("00000002", "user", [image("image/png", 7)]),
      message("00000003", "user", "只有文字"),
      {
        type: "custom",
        id: "00000004",
        parentId: null,
        message: { role: "user", content: [image("image/png", "eA==")] },
      },
    ]);

    await expect(
      Promise.all([
        readUserImage(path, "00000001", 0),
        readUserImage(path, "00000002", 0),
        readUserImage(path, "00000003", 0),
        readUserImage(path, "00000004", 0),
        readUserImage(path, "00000009", 0),
        readUserImage(join(folder, "gone.jsonl"), "00000001", 0),
      ]),
    ).resolves.toStrictEqual([null, null, null, null, null, null]);
  });

  it("waits for a message still being written", async () => {
    const path = await sessionFile(await tempDir("images"), "s.jsonl", [header("s1")]);
    await appendFile(path, JSON.stringify(message("00000001", "user", [image("image/png", "eA==")])));

    await expect(readUserImage(path, "00000001", 0)).resolves.toBeNull();
  });

  it("reads an image past the first chunk, in a line longer than one", async () => {
    const data = "QUJD".repeat(400_000);
    const path = await sessionFile(await tempDir("images"), "s.jsonl", [
      header("s1"),
      message("00000001", "user", "填充".repeat(400_000)),
      message("00000002", "user", [image("image/jpeg", data)]),
    ]);

    await expect(readUserImage(path, "00000002", 0)).resolves.toStrictEqual({ mimeType: "image/jpeg", data });
  });

  it("stops once its signal is aborted, and closes the file it opens", async () => {
    const path = await sessionFile(await tempDir("images"), "s.jsonl", [
      header("s1"),
      message("00000001", "user", [image("image/png", "eA==")]),
    ]);
    const before = openFiles();

    await readUserImage(path, "00000001", 0);
    await readUserImage(path, "00000009", 0);

    expect(openFiles()).toBe(before);
    await expect(readUserImage(path, "00000001", 0, AbortSignal.abort(new Error("stopped")))).rejects.toThrow(
      "stopped",
    );
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

describe("sessionDirectories", () => {
  it("counts the sessions of each working directory in pi's folders, links included, with when each was last used", async () => {
    const directory = await tempDir("pi-sessions");
    const folderA = join(directory, "--a--");
    await sessionFile(folderA, "1_s1.jsonl", [header("s1", "/a"), user("hi")], 300);
    await sessionFile(folderA, "2_s2.jsonl", [header("s2", "/a")], 100);
    // `/a` and `/-a` share a folder in pi's naming, so each file's own `cwd` counts.
    await sessionFile(folderA, "3_s3.jsonl", [header("s3", "/-a")], 200);
    await sessionFile(join(directory, "--b--"), "1_s4.jsonl", [header("s4", "/b")], 400);
    await sessionFile(folderA, "not-a-session.jsonl", [{ ...header("s5", "/m"), type: "message" }], 500);
    await sessionFile(folderA, "no-id.jsonl", [{ type: "session", cwd: "/n" }], 500);
    await sessionFile(folderA, "no-cwd.jsonl", [{ type: "session", id: "s5" }], 500);
    await sessionFile(folderA, "empty-cwd.jsonl", [header("s10", "")], 500);
    await symlink(join(directory, "nowhere.jsonl"), join(folderA, "broken.jsonl"));
    await mkdir(join(folderA, "folder.jsonl"));
    // A pipe would keep a reader waiting for a writer that never comes.
    execFileSync("mkfifo", [join(folderA, "pipe.jsonl")]);
    await sessionFile(folderA, "notes.txt", [header("s6", "/c")], 500);
    await writeFile(join(folderA, "4_s7.jsonl"), JSON.stringify(header("s7", "/d")));
    await sessionFile(directory, "1_s8.jsonl", [header("s8", "/e")], 500);
    const linked = await tempDir("linked-sessions");
    await sessionFile(linked, "1_s9.jsonl", [header("s9", "/f")], 600);
    // pi follows a link among its folders too.
    await symlink(linked, join(directory, "--f--"));

    const found = await sessionDirectories({ directory, perCwd: true });

    expect(found.toSorted((one, other) => one.cwd.localeCompare(other.cwd))).toStrictEqual([
      { cwd: "/-a", sessions: 1, lastUsedAt: 200_000 },
      { cwd: "/a", sessions: 2, lastUsedAt: 300_000 },
      { cwd: "/b", sessions: 1, lastUsedAt: 400_000 },
      { cwd: "/f", sessions: 1, lastUsedAt: 600_000 },
    ]);
  });

  it("closes every file it opens", async () => {
    const directory = await tempDir("pi-sessions");
    await sessionFile(join(directory, "--a--"), "1_s1.jsonl", [header("s1", "/a")]);
    const before = openFiles();

    await sessionDirectories({ directory, perCwd: true });

    expect(openFiles()).toBe(before);
  });

  it("reads the configured directory itself when pi keeps every session in one place", async () => {
    const directory = await tempDir("pi-sessions");
    await sessionFile(directory, "1_s1.jsonl", [header("s1", "/a")], 100);
    await sessionFile(join(directory, "--b--"), "1_s2.jsonl", [header("s2", "/b")], 200);

    expect(await sessionDirectories({ directory, perCwd: false })).toStrictEqual([
      { cwd: "/a", sessions: 1, lastUsedAt: 100_000 },
    ]);
  });

  it("finds nothing where pi has kept no sessions, and stops when cancelled", async () => {
    const directory = await tempDir("pi-sessions");
    await sessionFile(join(directory, "--a--"), "1_s1.jsonl", [header("s1", "/a")]);

    expect(await sessionDirectories({ directory: join(directory, "missing"), perCwd: true })).toStrictEqual([]);
    const reason = new Error("stopped");
    await expect(sessionDirectories({ directory, perCwd: true }, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});

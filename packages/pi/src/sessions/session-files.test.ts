import { createTempDir, parseFixture, present } from "@atrium/testkit";
import { chmod, mkdir, readFileSync, readdirSync, symlink, utimes, writeFile } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import { listSessionFiles, readSessionHead, sessionsDirectory } from "./session-files";

const write = promisify(writeFile);
const makeDir = promisify(mkdir);
const touch = promisify(utimes);
const link = promisify(symlink);
const changeMode = promisify(chmod);

/** A temporary directory removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  onTestFinished(dir.cleanup);
  return dir.path;
}

/** The lines of the session file pi wrote in the recorded history scenario. */
function recordedSessionLines(): string[] {
  const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", "history.jsonl"), "utf8"));
  const session = present(
    fixture.find((record) => record.kind === "session"),
    "the recorded session file",
  );
  return (session as unknown as { lines: unknown[] }).lines.map((line) => JSON.stringify(line));
}

/** Writes a session file into `folder`, changed at `modifiedAt` seconds since the epoch. */
async function sessionFile(folder: string, name: string, lines: unknown[], modifiedAt: number): Promise<string> {
  await makeDir(folder, { recursive: true });
  const path = join(folder, name);
  await write(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
  await touch(path, modifiedAt, modifiedAt);
  return path;
}

/** A session header. */
function header(id: string, cwd = "/work") {
  return { type: "session", version: 3, id, timestamp: "2026-10-08T00:00:00.000Z", cwd };
}

/** A user message entry with `content`. */
function user(content: unknown) {
  return {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp: "2026-10-08T00:00:00.000Z",
    message: { role: "user", content, timestamp: 0 },
  };
}

describe("listSessionFiles", () => {
  it("reads the session id, working directory and first question of a file pi wrote", async () => {
    const dir = await tempDir("sessions");
    const path = await sessionFile(join(dir, "--work--"), "2026-10-08_x.jsonl", recordedSessionLines(), 1_000);

    expect(await listSessionFiles(dir, 10)).toStrictEqual([
      { path, sessionId: "<uuid-1>", cwd: "<cwd>", modifiedAt: 1_000_000, firstPrompt: "one" },
    ]);
  });

  it("lists the newest first, as many as asked, across folders, the newest file of a session only", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(join(dir, "--a--"), "old.jsonl", [header("s1"), user("first")], 100);
    const newer = await sessionFile(join(dir, "--b--"), "new.jsonl", [header("s2"), user("second")], 300);
    const copy = await sessionFile(join(dir, "--a--"), "copy.jsonl", [header("s1"), user("copied")], 200);

    expect((await listSessionFiles(dir, 10)).map((file) => [file.path, file.firstPrompt])).toStrictEqual([
      [newer, "second"],
      [copy, "copied"],
    ]);
    expect((await listSessionFiles(dir, 1)).map((file) => file.sessionId)).toStrictEqual(["s2"]);
  });

  it("takes a question given as blocks, joining its text and skipping images", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(
      join(dir, "--a--"),
      "s.jsonl",
      [
        header("s1"),
        { type: "message", id: "x", parentId: null, timestamp: "", message: { role: "system", content: "" } },
        user([
          { type: "text", text: "look" },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "here" },
        ]),
      ],
      100,
    );

    expect((await listSessionFiles(dir, 10))[0]?.firstPrompt).toBe("look\nhere");
  });

  it("has no question for a file without a user message with text in its first part", async () => {
    const dir = await tempDir("sessions");
    const padding = { type: "custom", id: "p", parentId: null, timestamp: "", data: "x".repeat(300 * 1024) };
    await sessionFile(join(dir, "--a--"), "a.jsonl", [header("s1"), user([{ type: "image" }]), user(7)], 300);
    await sessionFile(join(dir, "--a--"), "b.jsonl", [header("s2"), padding, user("too late")], 200);
    await sessionFile(join(dir, "--a--"), "c.jsonl", [header("s3", undefined), "not json", user("ok")], 100);

    expect((await listSessionFiles(dir, 10)).map((file) => [file.sessionId, file.firstPrompt])).toStrictEqual([
      ["s1", null],
      ["s2", null],
      ["s3", "ok"],
    ]);
  });

  it("skips a broken link and a folder it cannot read", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(join(dir, "--a--"), "good.jsonl", [header("s1"), user("hi")], 100);
    await link(join(dir, "nowhere.jsonl"), join(dir, "--a--", "broken.jsonl"));
    await makeDir(join(dir, "--locked--"));
    await sessionFile(join(dir, "--locked--"), "hidden.jsonl", [header("s2"), user("x")], 200);
    await changeMode(join(dir, "--locked--"), 0o000);
    onTestFinished(() => changeMode(join(dir, "--locked--"), 0o755));

    expect((await listSessionFiles(dir, 10)).map((file) => file.sessionId)).toStrictEqual(["s1"]);
  });

  it("skips files that are not sessions, other files and loose files, and a missing directory", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(join(dir, "--a--"), "no-header.jsonl", [user("x")], 300);
    await sessionFile(join(dir, "--a--"), "no-id.jsonl", [{ type: "session" }], 300);
    await sessionFile(join(dir, "--a--"), "empty.jsonl", [], 300);
    await sessionFile(join(dir, "--a--"), "notes.txt", [header("s9")], 300);
    await sessionFile(dir, "loose.jsonl", [header("s8")], 300);
    await makeDir(join(dir, "--a--", "folder.jsonl"));
    await sessionFile(join(dir, "--a--"), "good.jsonl", [header("s1", "/w"), user("hi")], 100);

    expect((await listSessionFiles(dir, 10)).map((file) => file.sessionId)).toStrictEqual(["s1"]);
    expect(await listSessionFiles(join(dir, "missing"), 10)).toStrictEqual([]);
  });

  it("splits lines at LF only, so a lone CR between records does not end a line", async () => {
    const dir = await tempDir("sessions");
    const path = join(dir, "--a--", "a.jsonl");
    await makeDir(join(dir, "--a--"));
    await write(
      path,
      `${JSON.stringify(header("s1"))}\n${JSON.stringify(user("one"))}\r${JSON.stringify(user("two"))}\n`,
    );

    // Joined at the CR the two records are one line that is not JSON, so neither counts.
    expect((await listSessionFiles(dir, 10))[0]?.firstPrompt).toBeNull();
  });

  it("stops scanning once its signal is aborted", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(join(dir, "--a--"), "a.jsonl", [header("s1"), user("hi")], 100);
    const reason = new Error("closing");

    await expect(listSessionFiles(dir, 10, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it("gives a header without a working directory an empty one", async () => {
    const dir = await tempDir("sessions");
    await sessionFile(join(dir, "--a--"), "a.jsonl", [{ type: "session", id: "s1" }, user("hi")], 100);

    expect((await listSessionFiles(dir, 10))[0]?.cwd).toBe("");
  });
});

/** A file holding these lines, as given. */
async function fileWith(lines: string[]): Promise<string> {
  const dir = await tempDir("head");
  const path = join(dir, "s.jsonl");
  await write(path, lines.join("\n"));
  return path;
}

/** How many files this process has open; each holds a descriptor until it is closed. */
function openFiles(): number {
  return readdirSync("/dev/fd").length;
}

describe("readSessionHead", () => {
  it("takes no first line that is not a session header for a session", async () => {
    for (const first of [
      "null",
      "[]",
      '"session"',
      "7",
      "{}",
      '{"type":"session"}',
      '{"type":"session","id":7}',
      "not json",
    ]) {
      expect(await readSessionHead(await fileWith([first, JSON.stringify(user("hi"))]))).toBeNull();
    }
  });

  it("finds the question among records of every shape, and reads a last line without a line break", async () => {
    const path = await fileWith([
      JSON.stringify(header("s1")),
      "null",
      "[]",
      '"text"',
      JSON.stringify({ type: "message", message: null }),
      JSON.stringify({ type: "message", message: "user" }),
      JSON.stringify({ type: "message", message: { content: "no role" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "not a user" } }),
      JSON.stringify({ type: "other", message: { role: "user", content: "not a message entry" } }),
      JSON.stringify(user([null, "x", 3, { type: "text" }, { type: "text", text: 4 }, { text: "no type" }])),
      JSON.stringify(user(7)),
      JSON.stringify(user([{ type: "text", text: "found" }])),
    ]);

    expect(await readSessionHead(path)).toStrictEqual({ sessionId: "s1", cwd: "/work", firstPrompt: "found" });
  });

  it("closes every file it opens", async () => {
    const path = await fileWith([JSON.stringify(header("s1")), JSON.stringify(user("hi"))]);
    const before = openFiles();

    await readSessionHead(path);
    await readSessionHead(path);

    expect(openFiles()).toBe(before);
  });

  it("counts a file the system cannot read as none, and passes any other error on", async () => {
    const dir = await tempDir("head");

    expect(await readSessionHead(join(dir, "missing.jsonl"))).toBeNull();
    expect(await readSessionHead(dir)).toBeNull();
    await expect(readSessionHead(7 as unknown as string)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  });
});

describe("sessionsDirectory", () => {
  it("uses pi's session directory variable first, expanding ~", async () => {
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "~/s" })).toBe("/home/a/s");
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "/abs" })).toBe("/abs");
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_SESSION_DIR: "~" })).toBe("/home/a");
  });

  it("uses sessionDir from pi's global settings next, then sessions in pi's agent directory", async () => {
    const agent = await tempDir("agent");
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toBe(join(agent, "sessions"));

    await write(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/elsewhere" }));
    expect(
      await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: "" }),
    ).toBe("/home/a/elsewhere");

    await write(join(agent, "settings.json"), JSON.stringify({ sessionDir: "" }));
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toBe(join(agent, "sessions"));
    await write(join(agent, "settings.json"), "{ not json");
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toBe(join(agent, "sessions"));
    await write(join(agent, "settings.json"), JSON.stringify(["sessionDir"]));
    expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toBe(join(agent, "sessions"));
    for (const settings of ["null", '"text"', JSON.stringify({ sessionDir: 7 })]) {
      await write(join(agent, "settings.json"), settings);
      expect(await sessionsDirectory({ HOME: "/home/a", PI_CODING_AGENT_DIR: agent })).toBe(join(agent, "sessions"));
    }
  });

  it("defaults to ~/.pi/agent/sessions, with the agent directory variable expanded too", async () => {
    expect(await sessionsDirectory({ HOME: "/nowhere/home" })).toBe("/nowhere/home/.pi/agent/sessions");
    expect(await sessionsDirectory({ HOME: "/nowhere/home", PI_CODING_AGENT_DIR: "" })).toBe(
      "/nowhere/home/.pi/agent/sessions",
    );
    expect(await sessionsDirectory({ HOME: "/nowhere/home", PI_CODING_AGENT_DIR: "~/agent" })).toBe(
      "/nowhere/home/agent/sessions",
    );
  });
});

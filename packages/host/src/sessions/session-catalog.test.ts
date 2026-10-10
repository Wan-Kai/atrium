import { type SessionsLocation, createSessionFileReader, sessionFolder } from "@atrium/pi";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { loadIndexFile } from "../store/index-file";
import { SESSIONS_FILE } from "../store/index-schema";
import { type ContainerDir, createSessionCatalog } from "./session-catalog";

const A = "wks_000000000000000a";
const B = "wks_000000000000000b";

/**
 * A catalog over a fresh index and session directory, with two workspace directories.
 *
 * @remarks
 * Real files throughout; tests write session files where pi would.
 *
 * @sideEffects Creates the directories, removed when the test ends.
 * @param options - Whether pi keeps a folder per directory, and whether its location is known.
 * @returns The catalog and its surroundings.
 */
async function catalog(options: { perCwd?: boolean; known?: boolean } = {}) {
  const temp = await createTempDir("catalog");
  onTestFinished(temp.cleanup);
  const root = await realpath(temp.path);
  const location: SessionsLocation = { directory: join(root, "pi-sessions"), perCwd: options.perCwd ?? true };
  const chatsRoot = join(root, "chats");
  const dirs = { a: join(root, "app"), b: join(root, "web") };
  await mkdir(dirs.a);
  await mkdir(dirs.b);
  let workspaces: ContainerDir[] = [
    { id: A, dir: dirs.a },
    { id: B, dir: dirs.b },
  ];
  const { file } = await loadIndexFile(join(root, "index"), SESSIONS_FILE, 0);
  const clock = new FakeClock(5_000);
  const { logger, records } = recordingTracing();
  const sessions = createSessionCatalog({
    file,
    location: Promise.resolve(options.known === false ? null : location),
    chatsRoot,
    workspaces: () => workspaces,
    reader: createSessionFileReader(),
    clock,
    logger,
  });
  onTestFinished(() => sessions.close());
  let changes = 0;
  sessions.onChange(() => (changes += 1));
  return {
    sessions,
    root,
    dirs,
    chatsRoot,
    file,
    clock,
    logs: records,
    changes: () => changes,
    setWorkspaces: (next: ContainerDir[]) => (workspaces = next),
    /** Writes a session file where pi would, changed at `modifiedAt` seconds. */
    write: async (cwd: string, id: string, lines: unknown[] = [], modifiedAt = 100, name = `${id}.jsonl`) => {
      const folder = sessionFolder(location, cwd);
      await mkdir(folder, { recursive: true });
      const header = { type: "session", version: 3, id, timestamp: "", cwd };
      const path = join(folder, name);
      await writeFile(path, [header, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(""));
      await utimes(path, modifiedAt, modifiedAt);
      return path;
    },
  };
}

/** A user message entry. */
const user = (content: string) => ({
  type: "message",
  id: "u",
  parentId: null,
  timestamp: "",
  message: { role: "user", content },
});

describe("SessionCatalog", () => {
  it("lists the sessions run in registered directories, with their names, prompts and files", async () => {
    const { sessions, dirs, root, write } = await catalog();
    const path = await write(dirs.a, "s1", [
      user("## Fix the **build**\nmore"),
      { type: "session_info", name: "构建" },
    ]);
    await write(dirs.b, "s2", [user("hello")], 200);
    await write(join(root, "elsewhere"), "s3", [user("not ours")]);

    await sessions.scan();

    expect(sessions.list()).toStrictEqual([
      {
        sessionId: "s1",
        containerId: A,
        cwd: dirs.a,
        name: "构建",
        prompt: "Fix the build",
        file: path,
        state: "persisted",
        updatedAt: 100_000,
        archived: false,
        attention: null,
        handedOff: false,
      },
      expect.objectContaining({ sessionId: "s2", containerId: B, prompt: "hello", updatedAt: 200_000 }),
    ]);
  });

  it("checks each file's directory, since different directories can share pi's folder", async () => {
    const { sessions, root, write, setWorkspaces } = await catalog();
    // `/x/a-b` and `/x/a/b` both map to the folder `--x-a-b--`.
    const dashed = join(root, "a-b");
    const nested = join(root, "a", "b");
    await mkdir(dashed);
    await mkdir(nested, { recursive: true });
    const mine = await write(dashed, "s1", [], 100);
    await write(nested, "s2");
    // A newer file with the same id from the other directory must not take its place.
    await write(nested, "s1", [], 300, "other-s1.jsonl");
    expect(sessionFolder({ directory: join(root, "pi-sessions"), perCwd: true }, dashed)).toBe(
      sessionFolder({ directory: join(root, "pi-sessions"), perCwd: true }, nested),
    );
    setWorkspaces([{ id: A, dir: dashed }]);

    await sessions.scan();

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId, entry.file])).toStrictEqual([
      ["s1", A, mine],
    ]);
  });

  it("keeps a session Atrium created in its container while it exists, then files it by directory", async () => {
    const { sessions, dirs, write, setWorkspaces } = await catalog();
    await sessions.record({ sessionId: "s1", containerId: B, cwd: dirs.a });
    await write(dirs.a, "s1", [user("hi")]);
    await sessions.scan();
    expect(sessions.find("s1")?.containerId).toBe(B);

    setWorkspaces([{ id: A, dir: dirs.a }]);

    expect(sessions.find("s1")?.containerId).toBe(A);
  });

  it("lists a draft until its file appears, then records that it is one no longer", async () => {
    const { sessions, dirs, file, write, clock } = await catalog();
    clock.advance(1);
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });
    expect(sessions.list()).toStrictEqual([
      {
        sessionId: "s1",
        containerId: A,
        cwd: dirs.a,
        name: null,
        prompt: null,
        file: null,
        state: "draft",
        updatedAt: 5_001,
        archived: false,
        attention: null,
        handedOff: false,
      },
    ]);

    await write(dirs.a, "s1", [user("first")]);
    await sessions.scan();

    expect(sessions.find("s1")).toMatchObject({ state: "persisted", prompt: "first" });
    expect(file.read().sessions).toMatchObject([{ sessionId: "s1", draft: false }]);
  });

  it("calls a recorded session whose file went missing", async () => {
    const { sessions, dirs, write } = await catalog();
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });
    const path = await write(dirs.a, "s1", [user("first")]);
    await sessions.scan();

    await rm(path);
    await sessions.scan();

    expect(sessions.find("s1")).toMatchObject({ state: "missing", file: null, prompt: null, updatedAt: 5_000 });
  });

  it("forgets a discarded draft", async () => {
    const { sessions, dirs, changes } = await catalog();
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });

    await sessions.forget("s1");

    expect(sessions.list()).toStrictEqual([]);
    expect(changes()).toBe(2);
  });

  it("archives a session, recording one from the terminal, and ignores one it does not list", async () => {
    const { sessions, dirs, file, write } = await catalog();
    await write(dirs.a, "terminal", [user("hi")]);
    await sessions.record({ sessionId: "ours", containerId: A, cwd: dirs.a });
    await sessions.scan();

    await sessions.archive("terminal");
    await sessions.archive("ours");
    await sessions.archive("unknown");

    expect(sessions.list().map((entry) => [entry.sessionId, entry.archived])).toStrictEqual([
      ["terminal", true],
      ["ours", true],
    ]);
    expect(file.read().sessions).toMatchObject([
      { sessionId: "ours", archived: true, draft: true },
      { sessionId: "terminal", containerId: A, cwd: dirs.a, archived: true, draft: false, createdAt: 5_000 },
    ]);
  });

  it("marks a session's attention and hand-off, recording one from the terminal, and writes only a change", async () => {
    const { sessions, dirs, file, write, changes } = await catalog();
    await write(dirs.a, "terminal", [user("hi")]);
    await sessions.record({ sessionId: "ours", containerId: A, cwd: dirs.a });
    await sessions.scan();
    const before = changes();

    await sessions.mark("terminal", { attention: { reason: "auth", at: 7, cleared: false } });
    await sessions.mark("ours", { handedOff: true });
    await sessions.mark("ours", { handedOff: true });
    await sessions.mark("terminal", { attention: { reason: "auth", at: 7, cleared: false } });
    await sessions.mark("unknown", { handedOff: true });

    expect(sessions.list().map((entry) => [entry.sessionId, entry.attention, entry.handedOff])).toStrictEqual([
      ["terminal", { reason: "auth", at: 7, cleared: false }, false],
      ["ours", null, true],
    ]);
    expect(file.read().sessions).toStrictEqual([
      {
        sessionId: "ours",
        containerId: A,
        cwd: dirs.a,
        draft: true,
        archived: false,
        createdAt: 5_000,
        handedOff: true,
      },
      {
        sessionId: "terminal",
        containerId: A,
        cwd: dirs.a,
        draft: false,
        archived: false,
        createdAt: 5_000,
        attention: { reason: "auth", at: 7, cleared: false },
      },
    ]);
    expect(changes() - before).toBe(2);

    await sessions.mark("terminal", { attention: null });
    await sessions.mark("ours", { handedOff: false });
    expect(sessions.list().map((entry) => [entry.sessionId, entry.attention, entry.handedOff])).toStrictEqual([
      ["terminal", null, false],
      ["ours", null, false],
    ]);
  });

  it("does not record a session from the terminal for a mark it already has", async () => {
    const { sessions, dirs, file, write } = await catalog();
    await write(dirs.a, "terminal", [user("hi")]);
    await sessions.scan();

    await sessions.mark("terminal", { attention: null, handedOff: false });

    expect(file.read().sessions).toStrictEqual([]);
  });

  it("lists a new chat's draft before any scan", async () => {
    const { sessions, chatsRoot } = await catalog();

    await sessions.record({ sessionId: "draft", containerId: "chats", cwd: join(chatsRoot, "c1") });
    await sessions.record({ sessionId: "again", containerId: "chats", cwd: join(chatsRoot, "c1") });

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId])).toStrictEqual([
      ["draft", "chats"],
      ["again", "chats"],
    ]);
  });

  it("files every chat directory under the chats, and drops a chat whose directory was deleted", async () => {
    const { sessions, chatsRoot, write } = await catalog();
    const chat = join(chatsRoot, "c1");
    await mkdir(chat, { recursive: true });
    await writeFile(join(chatsRoot, "stray-file"), "");
    await write(chat, "s1", [user("why")]);
    await sessions.record({ sessionId: "draft", containerId: "chats", cwd: join(chatsRoot, "c2") });
    await mkdir(join(chatsRoot, "c2"));
    await sessions.scan();

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId, entry.state])).toStrictEqual([
      ["s1", "chats", "persisted"],
      ["draft", "chats", "draft"],
    ]);
    await rm(join(chatsRoot, "c2"), { recursive: true });
    await sessions.scan();
    expect(sessions.list().map((entry) => entry.sessionId)).toStrictEqual(["s1"]);
  });

  it("takes the newest file of a session found twice, and logs the conflict", async () => {
    const { sessions, dirs, write, logs } = await catalog();
    await write(dirs.a, "s1", [user("old")], 100, "old.jsonl");
    const newer = await write(dirs.a, "s1", [user("new")], 300, "new.jsonl");
    await write(dirs.b, "s1", [user("middle")], 200);

    await sessions.scan();

    expect(sessions.list()).toMatchObject([{ sessionId: "s1", file: newer, prompt: "new" }]);
    expect(logs.filter((record) => record["msg"] === "session found in more than one file")).toMatchObject([
      { level: "warn", sessionId: "s1" },
      { level: "warn", sessionId: "s1" },
    ]);
  });

  it("reads one shared directory when pi keeps every session in it", async () => {
    const { sessions, dirs, write } = await catalog({ perCwd: false });
    await write(dirs.a, "s1");
    await write(dirs.b, "s2");

    await sessions.scan();

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId])).toStrictEqual([
      ["s1", A],
      ["s2", B],
    ]);
  });

  it("lists only its records while it does not know where pi keeps sessions", async () => {
    const { sessions, dirs } = await catalog({ known: false });
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });

    await sessions.scan();

    expect(sessions.list().map((entry) => entry.state)).toStrictEqual(["draft"]);
  });

  it("tells listeners when a scan changed the list, and runs a scan asked for during one after it", async () => {
    const { sessions, dirs, write, changes } = await catalog();
    await write(dirs.a, "s1");
    await sessions.scan();
    expect(changes()).toBe(1);
    await sessions.scan();
    expect(changes()).toBe(1);

    await write(dirs.a, "s2");
    const first = sessions.scan();
    const second = sessions.scan();

    expect(second).toBe(first);
    await second;
    expect(sessions.list().map((entry) => entry.sessionId)).toStrictEqual(["s1", "s2"]);
    expect(changes()).toBe(2);
  });

  it("stops scanning once closed", async () => {
    const { sessions, dirs, write } = await catalog();
    await write(dirs.a, "s1");

    await sessions.close();

    await expect(sessions.scan()).rejects.toBeInstanceOf(Error);
    expect(sessions.list()).toStrictEqual([]);
  });

  it("writes its records to sessions.json", async () => {
    const { sessions, dirs, root } = await catalog();

    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });

    expect(JSON.parse(await readFile(join(root, "index", "sessions.json"), "utf8"))).toStrictEqual({
      version: 1,
      sessions: [{ sessionId: "s1", containerId: A, cwd: dirs.a, draft: true, archived: false, createdAt: 5_000 }],
    });
  });
});

describe("SessionCatalog before its first scan", () => {
  it("does not call a recorded session missing until a scan has looked, and starts that scan when waited for", async () => {
    const { sessions, dirs, file, write } = await catalog();
    await file.save({
      sessions: [{ sessionId: "s1", containerId: A, cwd: dirs.a, draft: false, archived: false, createdAt: 1 }],
    });
    expect(sessions.find("s1")?.state).toBe("persisted");
    await write(dirs.a, "s1", [user("still here")]);

    await sessions.ready();
    await sessions.ready();

    expect(sessions.find("s1")).toMatchObject({ state: "persisted", prompt: "still here" });
  });

  it("calls it missing once a scan found no file", async () => {
    const { sessions, dirs, file } = await catalog();
    await file.save({
      sessions: [{ sessionId: "s1", containerId: A, cwd: dirs.a, draft: false, archived: false, createdAt: 1 }],
    });

    await sessions.ready();

    expect(sessions.find("s1")?.state).toBe("missing");
  });
});

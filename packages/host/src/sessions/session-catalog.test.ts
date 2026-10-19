import { type SessionsLocation, createSessionFileReader, sessionFolder } from "@atrium/pi";
import { FakeClock, createTempDir, present } from "@atrium/testkit";
import { mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { loadIndexFile } from "../store/index-file";
import type { AgentRecord } from "../store/agent-records";
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
        fast: null,
        parent: null,
        usageAfter: null,
        agent: null,
        usedHandles: [],
        deliveries: [],
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
        fast: null,
        parent: null,
        usageAfter: null,
        agent: null,
        usedHandles: [],
        deliveries: [],
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

  it("forgets a discarded draft, and only it", async () => {
    const { sessions, dirs, changes } = await catalog();
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });
    await sessions.record({ sessionId: "s2", containerId: B, cwd: dirs.b });

    await sessions.forget("s1");

    expect(sessions.list().map((entry) => entry.sessionId)).toStrictEqual(["s2"]);
    expect(changes()).toBe(3);
  });

  it("files a draft under no container once its workspace is gone", async () => {
    const { sessions, dirs, setWorkspaces } = await catalog();
    await sessions.record({ sessionId: "s1", containerId: A, cwd: dirs.a });

    setWorkspaces([{ id: B, dir: dirs.b }]);

    expect(sessions.list()).toStrictEqual([]);
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

  it("keeps each session's Fast once switched, recording one from the terminal, and writes only a change", async () => {
    const { sessions, dirs, file, write, changes } = await catalog();
    await write(dirs.a, "terminal", [user("hi")]);
    await sessions.record({ sessionId: "ours", containerId: A, cwd: dirs.a });
    await sessions.scan();
    const before = changes();

    await sessions.mark("terminal", { fast: false });
    await sessions.mark("ours", { fast: true });
    await sessions.mark("ours", { fast: true });

    expect(sessions.list().map((entry) => [entry.sessionId, entry.fast])).toStrictEqual([
      ["terminal", false],
      ["ours", true],
    ]);
    expect(file.read().sessions).toStrictEqual([
      { sessionId: "ours", containerId: A, cwd: dirs.a, draft: true, archived: false, createdAt: 5_000, fast: true },
      {
        sessionId: "terminal",
        containerId: A,
        cwd: dirs.a,
        draft: false,
        archived: false,
        createdAt: 5_000,
        fast: false,
      },
    ]);
    expect(changes() - before).toBe(2);
  });

  it("does not record a session from the terminal for a mark it already has", async () => {
    const { sessions, dirs, file, write } = await catalog();
    await write(dirs.a, "terminal", [user("hi")]);
    await sessions.scan();

    await sessions.mark("terminal", { attention: null, handedOff: false });

    expect(file.read().sessions).toStrictEqual([]);
  });

  it("lists a new chat and its drafts before any scan", async () => {
    const { sessions, chatsRoot } = await catalog();

    await sessions.record({ sessionId: "draft", containerId: "cht_c1", cwd: join(chatsRoot, "c1") });
    await sessions.record({ sessionId: "again", containerId: "cht_c1", cwd: join(chatsRoot, "c1") });

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId])).toStrictEqual([
      ["draft", "cht_c1"],
      ["again", "cht_c1"],
    ]);
    expect(sessions.chats()).toStrictEqual([{ id: "cht_c1", dir: join(chatsRoot, "c1"), firstSessionId: "draft" }]);
  });

  it("makes each chat directory a chat of its own, and drops a chat whose directory was deleted", async () => {
    const { sessions, chatsRoot, write } = await catalog();
    const chat = join(chatsRoot, "c1");
    await mkdir(chat, { recursive: true });
    await writeFile(join(chatsRoot, "stray-file"), "");
    await mkdir(join(chatsRoot, "not a chat"));
    await write(chat, "s1", [user("why")]);
    await write(chat, "s2", [user("and")]);
    await sessions.record({ sessionId: "draft", containerId: "cht_c2", cwd: join(chatsRoot, "c2") });
    await mkdir(join(chatsRoot, "c2"));
    await sessions.scan();

    expect(sessions.list().map((entry) => [entry.sessionId, entry.containerId, entry.state])).toStrictEqual([
      ["s1", "cht_c1", "persisted"],
      ["s2", "cht_c1", "persisted"],
      ["draft", "cht_c2", "draft"],
    ]);
    expect(sessions.chats().map((entry) => entry.id)).toStrictEqual(["cht_c1", "cht_c2"]);
    await rm(join(chatsRoot, "c2"), { recursive: true });
    await sessions.scan();
    expect(sessions.list().map((entry) => entry.sessionId)).toStrictEqual(["s1", "s2"]);
    expect(sessions.chats().map((entry) => entry.id)).toStrictEqual(["cht_c1"]);
  });

  it("names a chat's first session: the earliest recorded, else the file changed first, archived ones left out", async () => {
    const { sessions, chatsRoot, write, file } = await catalog();
    const chat = join(chatsRoot, "c1");
    await mkdir(chat, { recursive: true });
    // "earliest" is recorded at 5 s but last written at 20 s, "terminal" written at 7 s and "later"
    // recorded at 10 s.
    await sessions.record({ sessionId: "later", containerId: "cht_c1", cwd: chat });
    await write(chat, "terminal", [user("from the terminal")], 7);
    await file.save({ sessions: file.read().sessions.map((record) => ({ ...record, createdAt: 10_000 })) });
    await sessions.record({ sessionId: "earliest", containerId: "cht_c1", cwd: chat });
    await write(chat, "earliest", [user("first")], 20);
    await sessions.scan();
    expect(sessions.chats()).toStrictEqual([{ id: "cht_c1", dir: chat, firstSessionId: "earliest" }]);

    await sessions.archive("earliest");
    expect(sessions.chats()).toStrictEqual([{ id: "cht_c1", dir: chat, firstSessionId: "terminal" }]);

    await sessions.archive("terminal");
    await sessions.archive("later");
    expect(sessions.chats()).toStrictEqual([{ id: "cht_c1", dir: chat, firstSessionId: null }]);
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
      version: 2,
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

  it("records a child conversation's parent, name and baseline, naming it by pi's name once pi has one", async () => {
    const { sessions, dirs, file, write } = await catalog();
    await sessions.record({
      sessionId: "c1",
      containerId: A,
      cwd: dirs.a,
      parent: { sessionId: "s1", by: "user" },
      name: "补测试",
      usageAfter: "e7",
    });
    await sessions.record({ sessionId: "c2", containerId: A, cwd: dirs.a, parent: null, persisted: true });

    expect(sessions.find("c1")).toMatchObject({
      name: "补测试",
      parent: { sessionId: "s1", by: "user" },
      usageAfter: "e7",
    });
    expect(file.read().sessions).toMatchObject([
      { sessionId: "c1", draft: true, name: "补测试", usageAfter: "e7", parent: { sessionId: "s1", by: "user" } },
      { sessionId: "c2", draft: false },
    ]);
    expect(Object.keys(present(file.read().sessions[1], "the second record"))).not.toContain("parent");

    await write(dirs.a, "c1", [user("hi")]);
    await sessions.scan();
    expect(sessions.find("c1")?.name).toBe("补测试");
    await write(dirs.a, "c1", [user("hi"), { type: "session_info", name: "测试用例" }], 200);
    await sessions.scan();
    expect(sessions.find("c1")?.name).toBe("测试用例");
  });

  it("detaches a child conversation, keeping the rest of its record, and writes nothing for one without a parent", async () => {
    const { sessions, dirs, file, changes } = await catalog();
    await sessions.record({
      sessionId: "c1",
      containerId: A,
      cwd: dirs.a,
      parent: { sessionId: "s1", by: "user" },
      name: "x",
    });
    await sessions.record({ sessionId: "s2", containerId: A, cwd: dirs.a });
    const before = changes();

    // Those without a parent first, while another session has one.
    await sessions.detach("s2");
    await sessions.detach("nobody");
    await sessions.detach("c1");

    expect(sessions.find("c1")?.parent).toBeNull();
    expect(file.read().sessions[0]).toMatchObject({ sessionId: "c1", name: "x" });
    expect(Object.keys(present(file.read().sessions[0], "the first record"))).not.toContain("parent");
    expect(changes()).toBe(before + 1);
  });

  it("reads a parent or a name the protocol could not carry, as a hand-edited index can hold, as none", async () => {
    const { sessions, dirs } = await catalog();
    for (const [sessionId, parent, name] of [
      ["c1", "", ""],
      ["c2", "p".repeat(129), "n".repeat(1025)],
      ["c3", "p".repeat(128), "n".repeat(1024)],
    ] as const) {
      await sessions.record({
        sessionId,
        containerId: A,
        cwd: dirs.a,
        parent: { sessionId: parent, by: "user" },
        name,
      });
    }

    expect(
      ["c1", "c2", "c3"].map((id) => [sessions.find(id)?.parent?.sessionId.length, sessions.find(id)?.name?.length]),
    ).toStrictEqual([
      [undefined, undefined],
      [undefined, undefined],
      [128, 1024],
    ]);
  });

  it("names a recorded session in its record, writing nothing for the same name or an unknown session", async () => {
    const { sessions, dirs, file, changes } = await catalog();
    await sessions.record({ sessionId: "c1", containerId: A, cwd: dirs.a, parent: { sessionId: "s1", by: "user" } });
    await sessions.record({ sessionId: "c2", containerId: A, cwd: dirs.a, parent: { sessionId: "s1", by: "user" } });
    const before = changes();

    await sessions.name("c1", "补测试");
    await sessions.name("c1", "补测试");
    await sessions.name("nobody", "x");

    expect(file.read().sessions.map((record) => record.name)).toStrictEqual(["补测试", undefined]);
    expect(changes()).toBe(before + 1);
  });

  it("records a child the agent opened, and reads its agent fields leniently: a broken one loses only itself", async () => {
    const { sessions, dirs, file } = await catalog();
    const agent: AgentRecord = {
      handle: "audit",
      role: "explore",
      toolGuard: "flags",
      startOn: { providerId: "faux", modelId: "faux-1", thinkingLevel: null },
      worktree: false,
      tasks: [{ taskId: "t-1", state: "open", at: 1 }],
    };
    await sessions.record({
      sessionId: "c1",
      containerId: A,
      cwd: dirs.a,
      parent: { sessionId: "s1", by: "agent" },
      name: "audit",
      agent,
    });
    const delivery = { id: "d1", kind: "task", from: "s1", taskId: "t-1", text: "look", at: 2, state: "waiting" };
    await file.save({
      ...file.read(),
      sessions: [
        ...file.read().sessions,
        {
          sessionId: "s1",
          containerId: A,
          cwd: dirs.a,
          draft: true,
          archived: false,
          createdAt: 1,
          agent: { handle: "x" },
          usedHandles: ["audit", 7, "tests"],
          deliveries: [delivery, { id: "d2" }, null],
        },
      ],
    });

    expect(sessions.find("c1")).toMatchObject({ agent, usedHandles: [], deliveries: [] });
    expect(sessions.find("s1")).toMatchObject({ agent: null, usedHandles: ["audit", "tests"], deliveries: [delivery] });
  });

  it("changes a session's agent fields, records a session from the terminal, and writes nothing that is the same", async () => {
    const { sessions, dirs, file, changes, write } = await catalog();
    await write(dirs.a, "term");
    await sessions.scan();
    const before = changes();
    const delivery = {
      id: "d1",
      kind: "report",
      from: "c1",
      taskId: "t-1",
      event: "finished",
      at: 2,
      state: "waiting",
    } as const;

    await sessions.changeAgent("term", (fields) => ({ ...fields, usedHandles: ["audit"], deliveries: [delivery] }));
    await sessions.changeAgent("term", (fields) => fields);
    await sessions.changeAgent("nobody", (fields) => ({ ...fields, usedHandles: ["x"] }));

    expect(sessions.find("term")).toMatchObject({ usedHandles: ["audit"], deliveries: [delivery], agent: null });
    expect(file.read().sessions).toMatchObject([
      { sessionId: "term", containerId: A, draft: false, usedHandles: ["audit"], deliveries: [delivery] },
    ]);
    expect(Object.keys(present(file.read().sessions[0], "the record"))).not.toContain("agent");
    expect(changes()).toBe(before + 1);

    await sessions.changeAgent("term", (fields) => ({ ...fields, deliveries: [] }));
    expect(file.read().sessions[0]).toMatchObject({ usedHandles: ["audit"], deliveries: [] });
  });
});

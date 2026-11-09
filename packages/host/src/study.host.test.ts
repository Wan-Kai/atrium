import { type AtriumClient, CommandError } from "@atrium/client";
import { GIT_SCENE_ENV, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";
import { PONG_ENTRIES, UNANSWERED_STATS } from "../test/scripted-chat";

// Runs pi and git; beside the other test files it takes over the default 5 seconds.
vi.setConfig({ testTimeout: 60_000 });

const MODEL = { providerId: "faux", modelId: "faux-1" };

/** What the one-shot pi answers when asked to name a direction. */
const NAMES = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: '{"dir":"node-backend","name":"Node 后端"}' }],
    stopReason: "stop",
  },
};

/**
 * A host whose pi answers naming and runs sessions, with git, and a client connected to it.
 *
 * @remarks
 * The learning directory is the host's default, inside its temporary home: the real
 * `~/Atrium/Learning` is never touched.
 *
 * @sideEffects Creates temporary directories and starts a host, both gone when the test ends.
 * @param piSessions - Where pi keeps sessions, when a test writes one there.
 * @param learningRoot - The learning directory, when a test keeps it across hosts.
 * @param more - The host's home, when a test puts files in it first, and the file a one-shot pi
 * records what it was started with into.
 * @returns The host, the client and the learning directory.
 */
async function studyHost(
  piSessions?: string,
  learningRoot?: string,
  more: { readonly home?: string; readonly recordTo?: string } = {},
): Promise<{ host: TestHost; client: AtriumClient; root: string }> {
  const bin = await createTempDir("study-bin");
  onTestFinished(bin.cleanup);
  const scripted = await writeScriptedPi(
    bin.path,
    {
      print: { lines: [NAMES], ...(more.recordTo === undefined ? {} : { recordTo: more.recordTo }) },
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: PONG_ENTRIES,
        get_session_stats: UNANSWERED_STATS,
      },
    },
    "pi",
  );
  const host = await startTestHost({
    toolEnv: {
      ...GIT_SCENE_ENV,
      PATH: `${bin.path}:${present(process.env["PATH"], "PATH")}`,
      ...scripted.env,
      ...(piSessions === undefined ? {} : { PI_CODING_AGENT_SESSION_DIR: piSessions }),
    },
    ...(learningRoot === undefined ? {} : { learningRoot }),
    ...(more.home === undefined ? {} : { home: more.home }),
  });
  onTestFinished(host.dispose);
  await host.host.tools;
  const client = host.connect();
  onTestFinished(() => client.disconnect());
  await client.connect();
  await vi.waitFor(() => expect(client.index.getState().ready).toBe(true));
  return { host, client, root: learningRoot ?? join(host.host.logFile, "..", "..", "Learning") };
}

/** Whether something is at a path. */
async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

describe("learning directions over the WebSocket (SPEC-0008, ML1)", () => {
  it("makes nothing before the first message; then names the direction, makes its directory and a discussion session", async () => {
    const { client, root } = await studyHost();
    expect(await exists(root)).toBe(false);
    expect(client.index.getState().directions).toStrictEqual([]);

    const { directionId, sessionId } = await client.createDirection(
      "我想学后端，目标是能自己写一个服务并部署上线",
      MODEL,
    );

    expect(directionId).toBe("lrn_node-backend");
    const dir = join(root, "node-backend");
    expect((await readdir(dir)).toSorted()).toStrictEqual([".atrium-study.json", "AGENTS.md", "lab"]);
    expect(JSON.parse(await readFile(join(dir, ".atrium-study.json"), "utf8"))).toMatchObject({
      version: 1,
      name: "Node 后端",
    });
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("Teach one idea at a time");
    expect(await exists(join(dir, "lab", ".git"))).toBe(true);
    const index = client.index.getState();
    expect(index.directions).toStrictEqual([
      {
        id: directionId,
        dir,
        name: "Node 后端",
        alias: null,
        broken: false,
        newer: false,
        discussing: true,
        archived: false,
        createdAt: expect.any(Number),
        pinnedAt: null,
        lastOpenedAt: expect.any(Number),
        progress: null,
        next: { primary: null, secondary: null },
      },
    ]);
    expect(index.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
      containerId: directionId,
      study: { kind: "discuss" },
      state: "draft",
    });
    expect(index.layout).toStrictEqual({
      container: directionId,
      tabs: { [directionId]: { open: [sessionId], active: sessionId } },
    });
  });

  it("names a direction with the model a new session starts on when the page sent none (2026-11-09)", async () => {
    const home = await createTempDir("study-home");
    onTestFinished(home.cleanup);
    const last = { providerId: "faux", modelId: "last" };
    await writeFile(
      join(home.path, "preferences.json"),
      JSON.stringify({ version: 3, appearance: "system", lastModel: last, thinkingByModel: {} }),
    );
    const records = await createTempDir("study-oneshot");
    onTestFinished(records.cleanup);
    const recordTo = join(records.path, "oneshot.json");
    const { client } = await studyHost(undefined, undefined, { home: home.path, recordTo });

    const { directionId } = await client.createDirection("我想学后端", null);

    expect(directionId).toBe("lrn_node-backend");
    const { argv } = JSON.parse(await readFile(recordTo, "utf8")) as { argv: string[] };
    expect(argv[argv.indexOf("--model") + 1]).toBe("faux/last");
  });

  it("archives a direction into Archive/, takes no new session there, and restores it to go on", async () => {
    const { client, root } = await studyHost();
    const { directionId, sessionId } = await client.createDirection("学后端", MODEL);
    await client.openSession(present(sessionId, "the discussion"));

    await client.archiveDirection(directionId);

    expect(await exists(join(root, "node-backend"))).toBe(false);
    expect(await exists(join(root, "Archive", "node-backend", ".atrium-study.json"))).toBe(true);
    const archived = client.index.getState();
    expect(archived.directions).toMatchObject([
      { id: directionId, archived: true, dir: join(root, "Archive", "node-backend") },
    ]);
    // Its tabs went; its sessions stay recorded under it, not archived.
    expect(archived.layout.container).toBeNull();
    expect(archived.layout.tabs[directionId]).toBeUndefined();
    expect(archived.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
      containerId: directionId,
      archived: false,
    });
    await expect(client.createSession(directionId)).rejects.toMatchObject({
      code: "direction_archived",
      params: { directionId },
    });
    // Archiving again does nothing.
    await client.archiveDirection(directionId);

    await client.restoreDirection(directionId);

    expect(await exists(join(root, "node-backend", ".atrium-study.json"))).toBe(true);
    expect(client.index.getState().directions).toMatchObject([{ id: directionId, archived: false }]);
    await client.openSession(present(sessionId, "the discussion"));
    expect(client.index.getState().layout.container).toBe(directionId);
    const another = await client.createSession(directionId);
    // Not the first: the learner asking, with no study tools (SPEC-0008, ML2).
    expect(client.index.getState().sessions.find((session) => session.sessionId === another.sessionId)).toMatchObject({
      containerId: directionId,
      study: { kind: "ask" },
    });
  });

  it("shows an archived direction's session from its file, without pi, and refuses to go on in it", async () => {
    const sessions = await createTempDir("study-pi-sessions");
    onTestFinished(sessions.cleanup);
    const { client, root } = await studyHost(sessions.path);
    const { directionId } = await client.createDirection("学后端", MODEL);
    const dir = await realpath(join(root, "node-backend"));
    // A session pi wrote there earlier; scripted pi would answer "pong" entries instead.
    const header = { type: "session", version: 3, id: "older-1", timestamp: "2026-11-06T09:00:00.000Z", cwd: dir };
    const user = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-11-06T09:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "先从 HTTP 讲起" }], timestamp: 1 },
    };
    await writeFile(join(sessions.path, "older-1.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
    await client.windowFocused();
    await vi.waitFor(() =>
      expect(client.index.getState().sessions.find((one) => one.sessionId === "older-1")?.containerId).toBe(
        directionId,
      ),
    );

    await client.archiveDirection(directionId);
    // Opened as the window opens it from the direction's home: a tab, and no pi to start.
    await client.openSession("older-1");
    await client.watch(["older-1"]);

    await vi.waitFor(() =>
      expect(client.session("older-1")?.getState()).toMatchObject({
        status: "ready",
        items: [{ kind: "turn", user: { text: "先从 HTTP 讲起" } }],
        run: null,
      }),
    );
    // Something at its old directory again does not let pi start there.
    await mkdir(dir);
    await expect(client.prompt("older-1", "接着讲")).rejects.toMatchObject({
      code: "direction_archived",
      params: { directionId },
    });
  });

  it("refuses to restore over what took its place, moving nothing", async () => {
    const { client, root } = await studyHost();
    const { directionId } = await client.createDirection("学后端", MODEL);
    await client.archiveDirection(directionId);
    await mkdir(join(root, "node-backend"));
    await writeFile(join(root, "node-backend", "mine.txt"), "mine");

    const refused = await client.restoreDirection(directionId).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(CommandError);
    expect(refused).toMatchObject({ code: "study_restore_conflict", params: { directionId } });
    expect(await readdir(join(root, "node-backend"))).toStrictEqual(["mine.txt"]);
    expect(await exists(join(root, "Archive", "node-backend", ".atrium-study.json"))).toBe(true);
    expect(client.index.getState().directions).toMatchObject([{ id: directionId, archived: true }]);
  });

  it("names, pins and remembers going into a direction in learning.json, across a restart of the list", async () => {
    const { client, host } = await studyHost();
    const { directionId } = await client.createDirection("学后端", MODEL);
    await client.selectContainer(null);

    await client.renameDirection(directionId, "后端");
    await client.pinDirection(directionId);
    await client.selectContainer(directionId);

    await vi.waitFor(() =>
      expect(client.index.getState().directions[0]).toMatchObject({
        alias: "后端",
        pinnedAt: expect.any(Number),
        lastOpenedAt: expect.any(Number),
      }),
    );
    const home = join(host.host.logFile, "..", "..");
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(join(home, "learning.json"), "utf8"))).toMatchObject({
        version: 1,
        directions: [
          { id: directionId, alias: "后端", pinnedAt: expect.any(Number), lastOpenedAt: expect.any(Number) },
        ],
      }),
    );
    await expect(client.renameDirection("lrn_nothing", "x")).rejects.toMatchObject({ code: "direction_not_found" });
  });

  it("lists a direction made outside Atrium once the window is focused", async () => {
    const { client, root } = await studyHost();
    await mkdir(join(root, "rust"), { recursive: true });
    await writeFile(join(root, "rust", ".atrium-study.json"), JSON.stringify({ version: 1, name: "Rust" }));

    await client.windowFocused();

    await vi.waitFor(() =>
      expect(client.index.getState().directions).toMatchObject([{ id: "lrn_rust", name: "Rust" }]),
    );
  });

  it("lists a direction's progress and next step, marks by hand into its file, and reads it again after a restart (ML2)", async () => {
    const learning = await createTempDir("study-learning");
    onTestFinished(learning.cleanup);
    const root = join(await realpath(learning.path), "Learning");
    const marker = {
      version: 1,
      name: "Go",
      mine: "kept",
      ladder: [
        { id: "l1", name: "语法", topics: "", pass: "", state: "current" },
        { id: "l2", name: "并发", topics: "", pass: "", state: "todo" },
      ],
      steps: { l1: [{ id: "s1", kind: "lesson", title: "变量", lesson: null, quiz: null, done: null }] },
      gaps: [],
      finishedAt: null,
    };
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(marker));
    const first = await studyHost(undefined, root);

    await vi.waitFor(() =>
      expect(first.client.index.getState().directions).toMatchObject([
        {
          id: "lrn_go",
          discussing: false,
          progress: { ladder: [{ id: "l1", state: "current" }, { id: "l2" }] },
          next: { primary: { type: "start", kind: "lesson", level: "l1", step: "s1", available: true } },
        },
      ]),
    );
    await first.client.markStudyStep("lrn_go", "l1", "s1", "lesson", true);

    expect(first.client.index.getState().directions[0]?.next).toStrictEqual({
      primary: { type: "start", kind: "quiz", level: "l1", step: "s1", available: false },
      secondary: { type: "mark", mark: "later", level: "l1", step: "s1" },
    });
    expect(JSON.parse(await readFile(join(root, "go", ".atrium-study.json"), "utf8"))).toMatchObject({
      mine: "kept",
      steps: { l1: [{ id: "s1", lesson: { by: "manual" } }] },
    });
    await expect(first.client.markStudyGap("lrn_go", "g1", true)).rejects.toMatchObject({ code: "study_not_found" });
    await expect(
      first.client.startStudySession("lrn_go", { kind: "quiz", level: "l1", step: "s1" }),
    ).rejects.toMatchObject({ code: "study_not_available" });
    await first.host.dispose();
    const second = await studyHost(undefined, root);

    await vi.waitFor(() =>
      expect(second.client.index.getState().directions[0]?.progress?.steps["l1"]?.[0]).toMatchObject({
        lesson: { by: "manual" },
      }),
    );
  });
});

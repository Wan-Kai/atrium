import { FakeClock, createTempDir } from "@atrium/testkit";
import type { SessionStudy } from "@atrium/protocol";
import { mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { ResourceTracker } from "../platform/resources";
import { MARKER, createDirections } from "./directions";
import { createProgressFiles } from "./progress-file";
import { createStudyTools } from "./study-tools";

/** A ladder call the discussion makes. */
const LADDER = {
  levels: [
    { name: "语法", topics: "", pass: "", skip: true },
    { name: "并发", topics: "", pass: "" },
  ],
  lessons: ["goroutine"],
};

/**
 * A learning directory with one direction, its sessions as the catalog has them, and the tools.
 *
 * @remarks
 * Real directories, the real scan and the real writer; the catalog is a map, as the tools only
 * look a session up.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @param sessions - The sessions, by id: their container and use.
 * @param content - The direction's marker.
 * @returns The tools, the direction's directory, the writer, the directions and the logs.
 */
async function setUp(
  sessions: Readonly<Record<string, { containerId: string; study: SessionStudy | null }>>,
  content: unknown = { version: 1, name: "Go" },
) {
  const temp = await createTempDir("study-tools");
  onTestFinished(temp.cleanup);
  const root = join(await realpath(temp.path), "Learning");
  const dir = join(root, "go");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MARKER), JSON.stringify(content));
  await mkdir(join(root, "Archive", "old"), { recursive: true });
  await writeFile(join(root, "Archive", "old", MARKER), JSON.stringify({ version: 1, name: "Old" }));
  const { logger, records } = recordingTracing();
  const directions = createDirections({ root, clock: new FakeClock(0), resources: new ResourceTracker(), logger });
  onTestFinished(() => directions.close());
  await directions.scan();
  const files = createProgressFiles({ root, random: () => "r", logger });
  const tools = createStudyTools({
    find: (sessionId) => sessions[sessionId],
    directions,
    files,
    logger,
  });
  return { tools, dir, files, directions, logs: records };
}

/** The direction's marker now. */
async function marker(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, MARKER), "utf8"));
}

const DISCUSS = { containerId: "lrn_go", study: { kind: "discuss" } } as const;

describe("StudyTools", () => {
  it("writes the discussion's ladder, then the list shows the progress", async () => {
    const { tools, dir, directions } = await setUp({ s1: DISCUSS });

    expect(await tools.call("s1", { op: "study_set_ladder", args: LADDER })).toStrictEqual({ ok: true, result: {} });
    expect(await marker(dir)).toMatchObject({
      name: "Go",
      ladder: [
        { id: "l1", state: "skipped" },
        { id: "l2", state: "current" },
      ],
    });
    expect(directions.find("lrn_go")).toMatchObject({
      discussing: false,
      progress: { ladder: [{ id: "l1" }, { id: "l2" }] },
    });
    expect(await tools.call("s1", { op: "study_set_name", args: { name: "Go 并发" } })).toStrictEqual({
      ok: true,
      result: {},
    });
    expect(await tools.call("s1", { op: "study_set_profile", args: { goal: "爬虫" } })).toStrictEqual({
      ok: true,
      result: {},
    });
    expect(await marker(dir)).toMatchObject({ name: "Go 并发", profile: { goal: "爬虫" } });
  });

  it("refuses the ladder's bounds with the host's code and parameters", async () => {
    const { tools } = await setUp({ s1: DISCUSS });
    const level = { name: "x", topics: "", pass: "" };

    expect(await tools.call("s1", { op: "study_set_ladder", args: { levels: [level], lessons: ["a"] } })).toStrictEqual(
      {
        ok: false,
        code: "study_ladder_size",
        params: { min: 2, max: 6, got: 1 },
      },
    );
    expect(
      await tools.call("s1", {
        op: "study_set_ladder",
        args: { levels: Array.from({ length: 7 }, () => level), lessons: ["a"] },
      }),
    ).toStrictEqual({
      ok: false,
      code: "study_ladder_size",
      params: { min: 2, max: 6, got: 7 },
    });
  });

  it("writes where the session's record says, not where its arguments would", async () => {
    const lesson = { containerId: "lrn_go", study: { kind: "lesson", level: "l2", step: "s1" } } as const;
    const quiz = { containerId: "lrn_go", study: { kind: "quiz", level: "l2", step: "s1" } } as const;
    const feynman = { containerId: "lrn_go", study: { kind: "feynman", level: "l2", step: "s1", gap: "g1" } } as const;
    const { tools, dir } = await setUp({ s1: DISCUSS, s2: lesson, s3: quiz, s4: feynman });
    await tools.call("s1", { op: "study_set_ladder", args: LADDER });

    expect(await tools.call("s2", { op: "study_report", args: {} })).toStrictEqual({ ok: true, result: {} });
    expect(
      await tools.call("s3", { op: "study_add_gap", args: { text: "关闭的 channel", question: 2 } }),
    ).toStrictEqual({
      ok: true,
      result: {},
    });
    expect(await tools.call("s3", { op: "study_report", args: { score: 3, of: 5 } })).toStrictEqual({
      ok: true,
      result: {},
    });
    expect(await tools.call("s4", { op: "study_fix_gap", args: {} })).toStrictEqual({ ok: true, result: {} });
    const written = await marker(dir);

    expect(Reflect.get(Object(written["steps"]), "l2")[0]).toMatchObject({
      id: "s1",
      lesson: { by: "agent" },
      quiz: { by: "agent", score: 3, of: 5 },
      done: null,
    });
    expect(written["gaps"]).toStrictEqual([
      { id: "g1", text: "关闭的 channel", from: { level: "l2", step: "s1", question: 2 }, fixed: { by: "agent" } },
    ]);
  });

  it("refuses a tool the session's use does not have, a session of no use, and one outside a direction", async () => {
    const { tools } = await setUp({
      s1: DISCUSS,
      ask: { containerId: "lrn_go", study: { kind: "ask" } },
      none: { containerId: "lrn_go", study: null },
      workspace: { containerId: "wks_0123456789abcdef", study: { kind: "lesson", level: "l2", step: "s1" } },
      archived: { containerId: "lrn_old", study: { kind: "discuss" } },
      gone: { containerId: "lrn_gone", study: { kind: "discuss" } },
    });
    const name = { op: "study_set_name", args: { name: "x" } } as const;
    for (const [sessionId, call] of [
      ["s1", { op: "study_report", args: {} }],
      ["s1", { op: "study_add_gap", args: { text: "x" } }],
      ["ask", name],
      ["none", name],
      ["workspace", { op: "study_report", args: {} }],
      ["archived", name],
      ["gone", name],
      ["unknown", name],
    ] as const) {
      expect(await tools.call(sessionId, call), `${sessionId} ${call.op}`).toStrictEqual({
        ok: false,
        code: "study_not_allowed",
      });
    }
  });

  it("refuses to write a broken file, and a Feynman session without its gap", async () => {
    const broken = await setUp({ s1: DISCUSS }, "not json");

    expect(await broken.tools.call("s1", { op: "study_set_name", args: { name: "x" } })).toStrictEqual({
      ok: false,
      code: "study_file_broken",
    });
    expect(await readFile(join(broken.dir, MARKER), "utf8")).toBe('"not json"');
    const { tools } = await setUp({
      f: { containerId: "lrn_go", study: { kind: "feynman", level: "l1", step: "s1" } },
    });

    expect(await tools.call("f", { op: "study_fix_gap", args: {} })).toStrictEqual({
      ok: false,
      code: "study_not_found",
    });
  });

  it("refuses a tool while its direction is being archived, and one whose directory became a link", async () => {
    const held = await setUp({ s1: DISCUSS });
    const release = Promise.withResolvers<void>();
    const archive = held.files.hold(held.dir, () => release.promise);

    expect(await held.tools.call("s1", { op: "study_set_name", args: { name: "x" } })).toStrictEqual({
      ok: false,
      code: "study_not_allowed",
    });
    release.resolve();
    await archive;
    const linked = await setUp({ s1: DISCUSS });
    await rename(linked.dir, `${linked.dir}-real`);
    await symlink(`${linked.dir}-real`, linked.dir);

    expect(await linked.tools.call("s1", { op: "study_set_name", args: { name: "x" } })).toStrictEqual({
      ok: false,
      code: "study_write_failed",
    });
  });

  it("logs each call by direction, tool and code only", async () => {
    const { tools, logs } = await setUp({ s1: DISCUSS });
    await tools.call("s1", { op: "study_set_name", args: { name: "秘密的名字" } });
    await tools.call("s1", { op: "study_set_ladder", args: { levels: [], lessons: ["a"] } });

    expect(logs.filter((record) => record["msg"] === "study tool")).toStrictEqual([
      expect.objectContaining({ directionId: "lrn_go", op: "study_set_name", code: null }),
      expect.objectContaining({ directionId: "lrn_go", op: "study_set_ladder", code: "study_ladder_size" }),
    ]);
    expect(JSON.stringify(logs)).not.toContain("秘密");
  });
});

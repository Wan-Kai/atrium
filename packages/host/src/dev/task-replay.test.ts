import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { main } from "./task-replay";

const FIXTURES = join(import.meta.dirname, "..", "tasks", "fixtures");

/** Runs the command and collects what it wrote. */
async function run(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, env, { write: (t) => void (out += t) }, { write: (t) => void (err += t) });
  return { code, out, err };
}

describe("pnpm task:replay", () => {
  it("prints each event with the node states, the task status and the actions", async () => {
    const { code, out } = await run([join(FIXTURES, "sibling-failed-then-rerun.jsonl")]);
    expect(code).toBe(0);
    expect(out).toContain(
      "#1 09:00:00 created task=选方案（兄弟失败后重跑）\n    nodes   N1=pending N2=pending N3=pending N4=pending\n    task    designing\n",
    );
    expect(out).toContain(
      "#8 09:00:59 node_failed node=N3 attempt=1 reason=crashed\n    nodes   N1=passed N2=running N3=failed N4=pending\n    task    stopped\n    actions stop_node N2 after_turn | notify failed N3 crashed | progress node_failed N3\n",
    );
    expect(out).toContain(
      "#9 09:01:03 node_held node=N2 attempt=1\n    nodes   N1=passed N2=held N3=failed N4=pending\n    task    stopped\n",
    );
    expect(out).toContain("    actions resume_node N3 | resume_node N2\n");
    expect(out.trimEnd().split("\n").slice(-4)).toStrictEqual([
      "#17 09:03:07 node_settled node=N4 attempt=1",
      "    nodes   N1=passed N2=passed N3=passed N4=passed",
      "    task    done",
      "    actions progress node_passed N4",
    ]);
  });

  it("shows the attempt of a reset node and what the send-back stops", async () => {
    const { out } = await run([join(FIXTURES, "send-back-resets-branches.jsonl")]);
    expect(out).toContain(
      "nodes   N1=running#2 N2=pending#2 N3=pending#2 N4=pending#2 H1=pending#2\n    task    running\n    actions stop_node N4 now | start_node N1#2 | progress node_started N1\n",
    );
  });

  it("shows what a waiting node waits for and marks a voided run", async () => {
    const { out } = await run([join(FIXTURES, "merge-blocked-then-graph-change.jsonl")]);
    expect(out).toContain("nodes   N1=passed H1=waiting(merge_blocked)\n    task    waiting\n");
    expect(out).toContain("nodes   N1=passed N2=running H1=pending*\n");
    expect(out).toContain("actions notify merge_blocked H1 merge_conflict\n");
    expect(out).toContain("actions merge H1\n");
    expect(out).toContain("actions progress merged H1 | progress node_passed H1 | unlock_workspace | ask_archive\n");
    expect(out).toContain("#11 09:02:04 graph_proposed author=agent note=加一个解决冲突的节点 nodes=3 edges=3\n");
  });

  it("reads the events.jsonl of a task directory, and resolves a relative path from INIT_CWD", async () => {
    const dir = await createTempDir("replay");
    try {
      await mkdir(join(dir.path, "tsk_1"));
      const text = await readFile(join(FIXTURES, "merge-blocked-then-graph-change.jsonl"), "utf8");
      await writeFile(join(dir.path, "tsk_1", "events.jsonl"), text);
      const direct = await run([join(dir.path, "tsk_1")]);
      const relative = await run(["tsk_1"], { INIT_CWD: dir.path });
      expect(direct.code).toBe(0);
      expect(relative.out).toBe(direct.out);
      expect(direct.out).toContain("#1 09:00:00 created");
    } finally {
      await dir.cleanup();
    }
  });

  it("says when the last line was cut short, and leaves it out", async () => {
    const dir = await createTempDir("replay");
    try {
      const text = await readFile(join(FIXTURES, "merge-blocked-then-graph-change.jsonl"), "utf8");
      await writeFile(join(dir.path, "events.jsonl"), `${text}{"seq":21,"at":1,"ty`);
      const { code, out } = await run([join(dir.path, "events.jsonl")]);
      expect(code).toBe(0);
      expect(out.endsWith("(the last line was cut short and is left out)\n")).toBe(true);
      expect(out).not.toContain("#21");
    } finally {
      await dir.cleanup();
    }
  });

  it("prints usage for no argument or more than one, and exits 2", async () => {
    for (const argv of [[], ["a", "b"]]) {
      const { code, err, out } = await run(argv);
      expect(code).toBe(2);
      expect(err).toBe("usage: pnpm task:replay <task directory | events.jsonl>\n");
      expect(out).toBe("");
    }
  });

  it("reports a file that is missing or not a log, and exits 1", async () => {
    const dir = await createTempDir("replay");
    try {
      const missing = await run([join(dir.path, "nope")]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("ENOENT");
      await writeFile(join(dir.path, "bad.jsonl"), '{"seq":1,"at":1,"type":"started"}\n');
      const bad = await run([join(dir.path, "bad.jsonl")]);
      expect(bad).toMatchObject({ code: 1, err: "the first event is not `created`\n" });
    } finally {
      await dir.cleanup();
    }
  });
});

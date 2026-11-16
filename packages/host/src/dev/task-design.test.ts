import { createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { agent, edges, human, newTask } from "../tasks/test-support";
import type { Task } from "../tasks/types";
import { describeDesign, designWarnings, findSource, lastWords, parseTaskDesignArgs } from "./task-design";

describe("parseTaskDesignArgs", () => {
  it("reads the session, the scope, the model, the home, the folders, the timeout and keep, relative to where it was typed", () => {
    expect(
      parseTaskDesignArgs(
        [
          "--from",
          "ses-1",
          "--scope",
          "login only",
          "--model",
          "p/m:high",
          "--home",
          "h",
          "--sessions",
          "s",
          "--cwd",
          "../r",
          "--timeout",
          "60",
          "--keep",
        ],
        "/work/dir",
        "/Users/me",
      ),
    ).toStrictEqual({
      sessionId: "ses-1",
      scope: "login only",
      model: "p/m:high",
      home: "/work/dir/h",
      sessions: "/work/dir/s",
      cwd: "/work/r",
      timeoutSeconds: 60,
      keep: true,
    });
  });

  it("defaults to the Atrium home under the user's home, pi's own session folder, no model and five minutes", () => {
    expect(parseTaskDesignArgs(["--from", "abc"], "/work", "/Users/me")).toStrictEqual({
      sessionId: "abc",
      scope: null,
      model: null,
      home: "/Users/me/.atrium",
      sessions: null,
      cwd: null,
      timeoutSeconds: 300,
      keep: false,
    });
  });

  it.each([
    [[], "--from needs a session id"],
    [["--from"], "--from needs a value"],
    [["--from", "../x"], "--from needs a session id"],
    [["--from", "a", "--bogus"], "unknown option --bogus"],
    [["--from", "a", "extra"], "unexpected argument extra"],
    [["--from", "a", "--timeout", "soon"], "--timeout is a number of seconds"],
    [["--from", "a", "--timeout", "0"], "--timeout is a number of seconds"],
  ])("refuses %j", (argv, message) => {
    expect(parseTaskDesignArgs(argv, "/work", "/Users/me")).toMatchObject({ error: expect.stringContaining(message) });
  });
});

describe("findSource", () => {
  it("finds the file by the session id among pi's folders and reads the directory from its header, without writing", async () => {
    const dir = await createTempDir("design-source");
    onTestFinished(dir.cleanup);
    await mkdir(join(dir.path, "--a--"), { recursive: true });
    await writeFile(
      join(dir.path, "--a--", "2026-11-05T10-00-00-000Z_abc-123.jsonl"),
      `${JSON.stringify({ type: "session", id: "abc-123", cwd: "/repo/x" })}\n{"type":"message"}\n`,
    );

    expect(await findSource(dir.path, "abc-123")).toStrictEqual({
      path: join(dir.path, "--a--", "2026-11-05T10-00-00-000Z_abc-123.jsonl"),
      cwd: "/repo/x",
    });
    expect(await findSource(dir.path, "abc-12")).toBeNull();
    expect(await findSource(join(dir.path, "nowhere"), "abc-123")).toBeNull();
  });

  it("is null for a file whose header names no directory", async () => {
    const dir = await createTempDir("design-source");
    onTestFinished(dir.cleanup);
    await writeFile(join(dir.path, "t_x1.jsonl"), "not json\n");
    await writeFile(join(dir.path, "t_x2.jsonl"), `${JSON.stringify({ type: "session", id: "x2" })}\n`);

    expect(await findSource(dir.path, "x1")).toBeNull();
    expect(await findSource(dir.path, "x2")).toBeNull();
  });
});

/** A task with a graph and a summary, as the design turn leaves it. */
function designed(
  nodes = [agent("N1", "explore"), agent("N2", "work"), agent("N3", "check"), human("H1", { merge: true })],
) {
  const task: Task = newTask(nodes, edges(["N1", "N2"], ["N2", "N3"], ["N3", "H1"], ["H1", "N2", "back"]));
  return {
    ...task,
    name: "Add shout",
    guide: { id: "feature", version: 1 },
    summary: {
      goal: "Add a flag",
      decisions: ["d1"],
      constraints: [],
      nonGoals: ["n1"],
      openQuestions: ["q1"],
      acceptance: ["a1"],
    },
  };
}

describe("designWarnings", () => {
  it("is quiet for a graph whose work node is followed by a check node and that ends at a human node", () => {
    expect(designWarnings(designed())).toStrictEqual([]);
  });

  it("names a work node with no check node after it, even when a check node comes before it", () => {
    expect(
      designWarnings(designed([agent("N1", "check"), agent("N2", "work"), agent("N3", "advise"), human("H1")])),
    ).toStrictEqual(["N2 writes code and no check node comes after it"]);
  });

  it("names a graph with no human node, and a task with no graph", () => {
    expect(
      designWarnings(designed([agent("N1", "explore"), agent("N2", "advise"), agent("N3", "advise"), agent("N4")])),
    ).toStrictEqual(["the graph has no human node to accept it"]);
    expect(designWarnings({ ...designed(), graphs: [], activeGraph: 0 })).toStrictEqual(["no graph was proposed"]);
  });
});

describe("describeDesign", () => {
  it("shows the guide, the summary, each node with its job, done lines and place in the graph, the back edges and the closing words", () => {
    const text = describeDesign(designed(), "Picked feature.\nOne question open.").join("\n");

    expect(text).toContain("task       Add shout");
    expect(text).toContain("guide      feature v1");
    expect(text).toContain("goal: Add a flag");
    expect(text).toContain("    - d1");
    expect(text).toContain("out of scope\n    - n1");
    expect(text).toContain("N2 · node N2 [work]");
    expect(text).toContain("job   do N2");
    expect(text).toContain("after N1");
    expect(text).toContain("H1 · node H1 [human, merges]");
    expect(text).toContain("H1 can send back to N2");
    expect(text).toContain("the task conversation told the user\n  Picked feature.\n  One question open.");
    expect(text).not.toContain("check these");
  });

  it("says when nothing was written or proposed, and lists the warnings", () => {
    const bare = { ...designed([agent("N1", "work")]), name: "", summary: { ...designed().summary, goal: "" } };
    const text = describeDesign(bare, null).join("\n");

    expect(text).toContain("task       (unnamed)");
    expect(text).toContain("goal: (not written)");
    expect(text).toContain("! N1 writes code and no check node comes after it");
    expect(text).not.toContain("told the user");
    expect(describeDesign({ ...bare, graphs: [], activeGraph: 0 }, null).join("\n")).toContain(
      "graph: (none proposed)",
    );
  });
});

/** A session file's line for a message. */
const message = (role: string, text: string, stopReason = "stop") =>
  JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], stopReason } });

describe("lastWords", () => {
  it("is what the assistant said when its last message ended the turn", async () => {
    const dir = await createTempDir("design-last");
    onTestFinished(dir.cleanup);
    const file = join(dir.path, "s.jsonl");
    await writeFile(
      file,
      `${message("user", "go")}\n${message("assistant", "first")}\n{"type":"custom_message"}\n${message("assistant", "I picked feature.")}\n`,
    );

    expect(await lastWords(file)).toBe("I picked feature.");
  });

  it("is null while the turn goes on (a tool call is last, or the user spoke last), and for a missing file", async () => {
    const dir = await createTempDir("design-last");
    onTestFinished(dir.cleanup);
    const file = join(dir.path, "s.jsonl");
    await writeFile(file, `${message("assistant", "calling", "toolUse")}\n`);
    expect(await lastWords(file)).toBeNull();
    await writeFile(file, `${message("assistant", "said")}\n${message("user", "more")}\n`);
    expect(await lastWords(file)).toBeNull();
    expect(await lastWords(join(dir.path, "missing.jsonl"))).toBeNull();
  });
});

import { createTempDir } from "@atrium/testkit";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { settledResources, startTestHost } from "../test/harness";

/** A direction with a ladder, as its marker holds it. */
const MARKER = {
  version: 1,
  name: "Rust",
  createdAt: "2026-11-10T00:00:00.000Z",
  profile: {},
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "current" },
    { id: "l2", name: "所有权", topics: "", pass: "", state: "todo" },
  ],
  steps: { l1: [{ id: "s1", kind: "lesson", title: "变量", lesson: null, quiz: null, done: null }] },
  gaps: [],
  finishedAt: null,
};

/**
 * How many file system watches Node holds open.
 *
 * @remarks
 * A watch closed by the host's count but not by Node shows only here (testing.md, "泄漏测试").
 *
 * @sideEffects none
 * @returns The count.
 */
function liveWatches(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

/**
 * The resource counts that are not zero.
 *
 * @remarks
 * A kind used once stays in the counts at 0.
 *
 * @sideEffects none
 * @param counts - The counts.
 * @returns Those above 0.
 */
function open(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count !== 0));
}

describe("a direction's viewer tab leaks (SPEC-0008, ML4)", () => {
  it("lets go of every visual's watch once the windows that read a direction's files and demos close", async () => {
    const learning = await createTempDir("visuals-leak-learning");
    onTestFinished(learning.cleanup);
    const root = join(await realpath(learning.path), "Learning");
    const dir = join(root, "rust");
    await mkdir(join(dir, "visuals"), { recursive: true });
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, ".atrium-study.json"), JSON.stringify(MARKER));
    await writeFile(join(dir, "visuals", "1-01-vars.html"), '<div id="vars">变量</div>');
    await writeFile(join(dir, "notes", "1-01.md"), "# 变量\n");
    const host = await startTestHost({ learningRoot: root });
    onTestFinished(host.dispose);
    const baseline = await settledResources(host.host);
    const watchesBefore = liveWatches();
    const first = host.connect();
    await first.connect();
    await vi.waitFor(() => expect(first.index.getState().directions.map(({ id }) => id)).toStrictEqual(["lrn_rust"]));
    first.disconnect();

    // A window opens the direction's archive, a note and a demo, again and again, then goes.
    for (let round = 0; round < 10; round += 1) {
      const client = host.connect();
      await client.connect();
      await client.listDir("lrn_rust", "");
      await client.listDir("lrn_rust", "visuals");
      await client.readFile("lrn_rust", "notes/1-01.md");
      const release = client.holdVisual("lrn_rust", "visuals/1-01-vars.html");
      const { url } = await client.resolveVisual("lrn_rust", "visuals/1-01-vars.html");
      // A demo not made yet is watched for, from the same folder.
      await expect(client.resolveVisual("lrn_rust", "visuals/1-02-later.html")).rejects.toMatchObject({
        code: "visual_missing",
      });
      expect(
        (await fetch(`http://127.0.0.1:${String(host.host.port)}/visual/${new URL(url).host}/a.html`)).status,
      ).toBe(200);
      expect(host.host.resources.snapshot()["visual.watch"]).toBe(1);
      release();
      client.disconnect();
      await vi.waitFor(() => expect(host.host.resources.snapshot()["visual.watch"]).toBe(0));
    }

    await vi.waitFor(() => expect(open(host.host.resources.snapshot())).toStrictEqual(open(baseline)));
    await vi.waitFor(() => expect(liveWatches()).toBe(watchesBefore));
  });

  it("lets go of a demo's watch and address as soon as its tab closes, with the window still connected (ML4 review)", async () => {
    const learning = await createTempDir("visuals-leak-release");
    onTestFinished(learning.cleanup);
    const root = join(await realpath(learning.path), "Learning");
    const dir = join(root, "rust");
    await mkdir(join(dir, "visuals"), { recursive: true });
    await writeFile(join(dir, ".atrium-study.json"), JSON.stringify(MARKER));
    await writeFile(join(dir, "visuals", "1-01-vars.html"), '<div id="vars">变量</div>');
    const host = await startTestHost({ learningRoot: root });
    onTestFinished(host.dispose);
    const client = host.connect();
    await client.connect();
    onTestFinished(() => client.disconnect());
    await vi.waitFor(() => expect(client.index.getState().directions.map(({ id }) => id)).toStrictEqual(["lrn_rust"]));
    // The window stays, so what it holds is in the baseline.
    const baseline = await settledResources(host.host);
    const watchesBefore = liveWatches();
    const page = (url: string) =>
      fetch(`http://127.0.0.1:${String(host.host.port)}/visual/${new URL(url).host}/a.html`);

    // One window opens the demo and one not made yet, again and again, closing their tabs each time.
    for (let round = 0; round < 10; round += 1) {
      const release = client.holdVisual("lrn_rust", "visuals/1-01-vars.html");
      const releaseLater = client.holdVisual("lrn_rust", "visuals/1-02-later.html");
      const { url } = await client.resolveVisual("lrn_rust", "visuals/1-01-vars.html");
      await expect(client.resolveVisual("lrn_rust", "visuals/1-02-later.html")).rejects.toMatchObject({
        code: "visual_missing",
      });
      expect((await page(url)).status).toBe(200);
      expect(host.host.resources.snapshot()["visual.watch"]).toBe(1);
      release();
      releaseLater();
      await vi.waitFor(() => expect(host.host.resources.snapshot()["visual.watch"]).toBe(0));
      expect((await page(url)).status).toBe(404);
    }

    expect(client.connection.getState().status).toBe("connected");
    await vi.waitFor(() => expect(open(host.host.resources.snapshot())).toStrictEqual(open(baseline)));
    await vi.waitFor(() => expect(liveWatches()).toBe(watchesBefore));
  });
});

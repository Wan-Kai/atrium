import { FakeClock, GIT_SCENE_ENV, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { settledResources, startTestHost } from "../../test/harness";
import { recordingTracing } from "../../test/recording-tracing";
import { PONG_ENTRIES, UNANSWERED_STATS } from "../../test/scripted-chat";
import { ResourceTracker } from "../platform/resources";
import { createDirections } from "./directions";

/**
 * How many file system watches Node holds open.
 *
 * @remarks
 * A watch closed by our count but not by Node shows up only here (testing.md, "泄漏测试").
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

describe("learning directory leaks (SPEC-0008, ML1)", () => {
  it("lets go of every watch and timer once closed, however often it scanned, watched and saw changes", async () => {
    const temp = await createTempDir("directions-leak");
    onTestFinished(temp.cleanup);
    const root = join(await realpath(temp.path), "Learning");
    await mkdir(root);
    const resources = new ResourceTracker();
    const before = liveWatches();

    // Closed with the gathered scan still waiting, as a direction comes just then.
    for (let round = 0; round < 10; round += 1) {
      const directions = createDirections({
        root,
        clock: new FakeClock(),
        resources,
        logger: recordingTracing().logger,
      });
      await directions.scan();
      directions.watch();
      await directions.scan();
      const dir = join(root, `waiting${String(round)}`);
      await mkdir(dir);
      await writeFile(join(dir, ".atrium-study.json"), JSON.stringify({ version: 1, name: "x" }));
      await directions.close();
      await rm(dir, { recursive: true });
    }
    // Closed after the watch saw a direction come and its scan ran.
    for (let round = 0; round < 10; round += 1) {
      const clock = new FakeClock();
      const directions = createDirections({ root, clock, resources, logger: recordingTracing().logger });
      await directions.scan();
      const dir = join(root, `seen${String(round)}`);
      await vi.waitFor(
        async () => {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, ".atrium-study.json"), JSON.stringify({ version: 1, name: "x" }));
          expect(resources.snapshot()["timer"]).toBe(1);
        },
        { timeout: 10_000, interval: 100 },
      );
      clock.advance(200);
      await vi.waitFor(() => expect(directions.find(`lrn_seen${String(round)}`)?.name).toBe("x"));
      await directions.close();
      await rm(dir, { recursive: true });
    }

    expect(resources.snapshot()["study.watch"]).toBe(0);
    expect(resources.snapshot()["timer"]).toBe(0);
    await vi.waitFor(() => expect(liveWatches()).toBe(before));
  });

  it("comes back to the host's own counts after directions are made, archived and restored", async () => {
    const bin = await createTempDir("directions-leak-bin");
    onTestFinished(bin.cleanup);
    const reply = '{"dir":"go","name":"Go"}';
    const scripted = await writeScriptedPi(
      bin.path,
      {
        print: {
          lines: [
            {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" },
            },
          ],
        },
        rules: {
          get_state: { data: { sessionId: "pi-session-1" } },
          get_entries: PONG_ENTRIES,
          get_session_stats: UNANSWERED_STATS,
        },
      },
      "pi",
    );
    const host = await startTestHost({
      toolEnv: { ...GIT_SCENE_ENV, PATH: `${bin.path}:${present(process.env["PATH"], "PATH")}`, ...scripted.env },
    });
    onTestFinished(host.dispose);
    const client = host.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    const baseline = await settledResources(host.host);

    for (let round = 0; round < 3; round += 1) {
      const { directionId, sessionId } = await client.createDirection("学 Go", {
        providerId: "faux",
        modelId: "faux-1",
      });
      await client.openSession(present(sessionId, "the discussion"));
      await client.archiveDirection(directionId);
      await client.restoreDirection(directionId);
      await client.archiveDirection(directionId);
    }

    // The watch stays, now that the learning directory is there; nothing else does.
    await vi.waitFor(() =>
      expect(open(host.host.resources.snapshot())).toStrictEqual(open({ ...baseline, "study.watch": 1 })),
    );
  });
});

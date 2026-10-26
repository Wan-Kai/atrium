import { runOneShot } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { existsSync } from "node:fs";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { createPiDeps } from "../platform/pi-deps";
import { createReplyTranslations, TRANSLATION_OUTPUT_BYTES } from "./reply-translation";

/**
 * Counts real Node timers independently of resource bookkeeping.
 * @remarks A cancelled timer must disappear from Node as well as the host's own counters.
 * @sideEffects none
 * @returns The count.
 */
function liveTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

/**
 * Whether a completed model's process still exists.
 * @remarks Signal zero never signals the process.
 * @sideEffects none
 * @param pid - The process id recorded by the scripted pi.
 * @returns Whether it exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("reply translation resources", () => {
  it("returns processes, timers and request signals to baseline after 200 translations", async () => {
    const directory = await createTempDir("translation-leak");
    onTestFinished(directory.cleanup);
    const recordTo = `${directory.path}/last-call.json`;
    const scripted = await writeScriptedPi(directory.path, {
      print: {
        recordTo,
        lines: [
          {
            type: "message_end",
            message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "译文" }] },
          },
        ],
      },
    });
    const recording = recordingTracing();
    onTestFinished(recording.shutdown);
    const deps = createPiDeps({
      clock: systemClock,
      resources: recording.resources,
      logger: recording.logger,
      env: { PATH: present(process.env["PATH"], "PATH") },
    });
    const signals: WeakRef<AbortSignal>[] = [];
    const translations = createReplyTranslations({
      source: () => ({ cwd: directory.path, text: "Original reply", model: { providerId: "faux", modelId: "faux-1" } }),
      language: () => "简体中文",
      run: (request, signal) => {
        signals.push(new WeakRef(signal));
        return runOneShot({ piPath: scripted.piPath, env: scripted.env, ...request }, deps, {
          signal,
          maxOutputBytes: TRANSLATION_OUTPUT_BYTES,
          isolateTranslation: true,
        });
      },
    });
    onTestFinished(() => translations.close());
    await translations.translate("connection", "warmup", "session", "turn");
    const baseline = recording.resources.snapshot();
    const timers = liveTimers();
    for (let round = 0; round < 200; round += 1) {
      await expect(translations.translate("connection", `tr-${round}`, "session", "turn")).resolves.toStrictEqual({
        text: "译文",
        language: "简体中文",
        model: { providerId: "faux", modelId: "faux-1" },
      });
    }
    await translations.close();
    expect(recording.resources.snapshot()).toStrictEqual(baseline);
    const record: { readonly pid: number } = JSON.parse(await readFile(recordTo, "utf8"));
    expect(alive(record.pid)).toBe(false);
    await vi.waitFor(() => expect(liveTimers()).toBeLessThanOrEqual(timers));
    await setImmediate();
    globalThis.gc?.();
    expect(signals.map((signal) => signal.deref()).filter((signal) => signal !== undefined)).toStrictEqual([]);
  });

  it("returns processes, guards, timers and signals to baseline after 50 cancelled translations", async () => {
    const directory = await createTempDir("translation-cancel-leak");
    onTestFinished(directory.cleanup);
    const recordTo = `${directory.path}/last-call.json`;
    const scripted = await writeScriptedPi(directory.path, { print: { recordTo, hang: true } });
    const recording = recordingTracing();
    onTestFinished(recording.shutdown);
    const deps = createPiDeps({
      clock: systemClock,
      resources: recording.resources,
      logger: recording.logger,
      env: { PATH: present(process.env["PATH"], "PATH") },
    });
    const signals: WeakRef<AbortSignal>[] = [];
    const translations = createReplyTranslations({
      source: () => ({ cwd: directory.path, text: "Original reply", model: { providerId: "faux", modelId: "faux-1" } }),
      language: () => "简体中文",
      run: (request, signal) => {
        signals.push(new WeakRef(signal));
        return runOneShot({ piPath: scripted.piPath, env: scripted.env, ...request }, deps, {
          signal,
          maxOutputBytes: TRANSLATION_OUTPUT_BYTES,
          isolateTranslation: true,
        });
      },
    });
    onTestFinished(() => translations.close());
    const baseline = { ...recording.resources.snapshot(), "pi-oneshot": 0, timer: 0 };
    const timers = liveTimers();
    let previousPid = 0;
    for (let round = 0; round < 50; round += 1) {
      const id = `cancel-${round}`;
      const result = translations.translate("connection", id, "session", "turn").catch((error: unknown) => error);
      const record = await vi.waitFor(async () => {
        const seen: { readonly pid: number; readonly argv: readonly string[] } = JSON.parse(
          await readFile(recordTo, "utf8"),
        );
        expect(seen.pid).not.toBe(previousPid);
        return seen;
      });
      const guard = present(record.argv[record.argv.indexOf("--extension") + 1], "guard extension");
      await translations.cancel("connection", id);
      // Cancellation acknowledgement must wait for process and private-file cleanup, not just signal it.
      expect(alive(record.pid)).toBe(false);
      expect(existsSync(guard)).toBe(false);
      expect(recording.resources.snapshot()).toStrictEqual(baseline);
      expect(await result).toStrictEqual(new CommandError("translation_failed", { reason: "aborted" }));
      previousPid = record.pid;
    }
    await translations.close();
    await vi.waitFor(() => expect(liveTimers()).toBeLessThanOrEqual(timers));
    await setImmediate();
    globalThis.gc?.();
    expect(signals.map((signal) => signal.deref()).filter((signal) => signal !== undefined)).toStrictEqual([]);
  });
});

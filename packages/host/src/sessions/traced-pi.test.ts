import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { createPiDeps } from "../platform/pi-deps";
import { inSpan } from "../platform/tracing";
import { type TracedPi, startTracedPi } from "./traced-pi";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Starts a scripted pi through `startTracedPi`, recording logs and spans in memory. */
async function start(behavior: ScriptedPiBehavior) {
  const dir = await createTempDir("traced-pi");
  const scripted = await writeScriptedPi(dir.path, behavior);
  const recording = recordingTracing();
  const deps = createPiDeps({
    clock: systemClock,
    resources: recording.resources,
    logger: recording.logger,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  const traced: TracedPi = startTracedPi({
    launch: { piPath: scripted.piPath, args: [], cwd: dir.path, env: scripted.env },
    deps,
    tracer: recording.tracer,
  });
  const events: Record<string, unknown>[] = [];
  traced.process.onEvent((event) => events.push(event));
  cleanups.push(dir.cleanup, recording.shutdown, () => traced.process.stop());
  return { ...recording, traced, events };
}

/** The span record with this name, once it has been written. */
function spanNamed(records: readonly Record<string, unknown>[], name: string): Promise<Record<string, unknown>> {
  return vi.waitFor(
    () =>
      present(
        records.find((record) => record["kind"] === "span" && record["name"] === name),
        name,
      ),
    { timeout: 15_000 },
  );
}

describe("startTracedPi", () => {
  it("logs pi's lifecycle and stderr under a pi.process span that ends, as an error, when pi crashes", async () => {
    const { traced, records } = await start({ stderr: "boom\n", exitCode: 3 });

    await traced.process.exited;
    const span = await spanNamed(records, "pi.process");

    expect(span).toMatchObject({
      status: "error",
      attributes: { "pi.pid": traced.process.pid, "pi.exit.code": 3, "pi.exit.signal": "", "pi.exit.requested": false },
    });
    const logs = records.filter((record) => record["kind"] !== "span");
    expect(logs.map((record) => [record["msg"], record["span_id"], record["trace_id"]])).toStrictEqual([
      ["pi started", span["span_id"], span["trace_id"]],
      ["pi stderr", span["span_id"], span["trace_id"]],
      ["pi exited", span["span_id"], span["trace_id"]],
    ]);
    expect(logs[1]).toMatchObject({ line: "boom" });
  });

  it("ends the pi.process span as ok when the host stops pi, leaving no open span or timer", async () => {
    const { traced, records, resources, events } = await start({ announceArgv: true });
    // Stop only once pi runs, so a slow start under load is not mistaken for a pi ignoring stdin.
    await vi.waitFor(() => expect(events.map((event) => event["type"])).toContain("argv"), { timeout: 15_000 });

    await traced.process.stop();
    const span = await spanNamed(records, "pi.process");

    expect(span).toMatchObject({ status: "ok", attributes: { "pi.exit.code": 0, "pi.exit.requested": true } });
    expect(resources.snapshot()).toMatchObject({ span: 0, timer: 0, "pi-process": 0 });
  });

  it("sends each command in a pi.rpc span under the caller's span, with an id derived from it", async () => {
    const { traced, records, tracer, events } = await start({ rules: { get_state: { data: { ok: true } } } });

    const result = await inSpan(tracer, "run", () => traced.request({ type: "get_state" }));
    const rpc = await spanNamed(records, "pi.rpc get_state");
    const run = await spanNamed(records, "run");

    expect(result).toStrictEqual({ ok: true });
    expect(rpc).toMatchObject({ status: "ok", parent_span_id: run["span_id"], trace_id: run["trace_id"] });
    expect(events).toContainEqual({
      type: "received",
      record: { type: "get_state", id: `${String(rpc["span_id"])}-1` },
    });
  });

  it("marks the pi.rpc span as an error when pi rejects the command", async () => {
    const { traced, records } = await start({ rules: { set_model: { fail: "Model not found: x/y" } } });

    const error = await traced
      .request({ type: "set_model", provider: "x", modelId: "y" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "rejected", detail: "Model not found: x/y" });
    expect(await spanNamed(records, "pi.rpc set_model")).toMatchObject({ status: "error" });
  });
});

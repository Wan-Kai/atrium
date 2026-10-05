import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { createPiDeps } from "./pi-deps";
import { inSpan } from "./tracing";

/** Dependencies over a fake clock and in-memory logs. */
function setup() {
  const recording = recordingTracing();
  const clock = new FakeClock();
  const deps = createPiDeps({ clock, resources: recording.resources, logger: recording.logger, env: { PATH: "/p" } });
  return { ...recording, clock, deps };
}

describe("createPiDeps", () => {
  it("derives request ids from the active span, numbered so one span can send several", async () => {
    const { deps, tracer } = setup();

    const [spanId, ids] = await inSpan(tracer, "run", (span) =>
      Promise.resolve([span.spanContext().spanId, [deps.nextRequestId(), deps.nextRequestId()]] as const),
    );
    const outside = deps.nextRequestId();

    expect(ids).toStrictEqual([`${spanId}-1`, `${spanId}-2`]);
    expect(outside).toMatch(/^[0-9a-f]{16}-3$/);
    expect(outside.startsWith(spanId)).toBe(false);
  });

  it("counts pi's timers as host timers until they fire or are cancelled", () => {
    const { deps, clock, resources } = setup();
    const fired: string[] = [];

    deps.clock.setTimeout(() => fired.push("first"), 100);
    const cancel = deps.clock.setTimeout(() => fired.push("second"), 200);
    expect(resources.snapshot()["timer"]).toBe(2);
    clock.advance(100);
    cancel();

    expect(fired).toStrictEqual(["first"]);
    expect(resources.snapshot()["timer"]).toBe(0);
    expect(deps.clock.now()).toBe(clock.now());
  });

  it("counts resources pi tracks", () => {
    const { deps, resources } = setup();

    const release = deps.track("pi-process");
    expect(resources.snapshot()["pi-process"]).toBe(1);
    release();

    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("writes pi's logs at their level with the active span's ids", async () => {
    const { deps, tracer, records } = setup();

    const spanId = await inSpan(tracer, "run", (span) => {
      deps.log.debug({ n: 1 }, "d");
      deps.log.info({ n: 2 }, "i");
      deps.log.warn({ n: 3 }, "w");
      deps.log.error({ n: 4 }, "e");
      return Promise.resolve(span.spanContext().spanId);
    });

    expect(
      records.filter((record) => record["kind"] !== "span").map((r) => [r["level"], r["n"], r["msg"], r["span_id"]]),
    ).toStrictEqual([
      ["debug", 1, "d", spanId],
      ["info", 2, "i", spanId],
      ["warn", 3, "w", spanId],
      ["error", 4, "e", spanId],
    ]);
    expect(deps.env).toStrictEqual({ PATH: "/p" });
  });
});

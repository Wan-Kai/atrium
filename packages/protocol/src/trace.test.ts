import { describe, expect, it } from "vitest";
import { createTraceContext, formatTraceparent, parseTraceparent } from "./trace";

/** Returns a random source that yields the given byte arrays in order. */
function scriptedRandom(...draws: number[][]) {
  const queue = [...draws];
  return (length: number) => {
    const next = queue.shift();
    if (next === undefined || next.length !== length) throw new Error(`unexpected draw of ${length}`);
    return Uint8Array.from(next);
  };
}

describe("createTraceContext", () => {
  it("builds lowercase hex ids from the random source", () => {
    const random = scriptedRandom([0xab, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0f], [1, 2, 3, 4, 5, 6, 7, 0xff]);
    expect(createTraceContext(random)).toStrictEqual({
      traceId: "ab00000000000000000000000000000f",
      spanId: "01020304050607ff",
      sampled: true,
    });
  });

  it("redraws ids that come out all zeros", () => {
    const zeros16 = Array.from({ length: 16 }, () => 0);
    const zeros8 = Array.from({ length: 8 }, () => 0);
    const random = scriptedRandom(zeros16, [...zeros16.slice(1), 1], zeros8, [...zeros8.slice(1), 2]);
    expect(createTraceContext(random)).toStrictEqual({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000002",
      sampled: true,
    });
  });
});

describe("parseTraceparent", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";

  it("reads a sampled version-00 value", () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toStrictEqual({ traceId, spanId, sampled: true });
  });

  it("reads the sampled bit from flags that carry other bits", () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-02`)).toStrictEqual({ traceId, spanId, sampled: false });
    expect(parseTraceparent(`00-${traceId}-${spanId}-03`)).toStrictEqual({ traceId, spanId, sampled: true });
  });

  it.each([
    ["an unknown version", `01-${traceId}-${spanId}-01`],
    ["uppercase hex", `00-${traceId.toUpperCase()}-${spanId}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${spanId}-01`],
    ["an all-zero span id", `00-${traceId}-${"0".repeat(16)}-01`],
    ["a short trace id", `00-${traceId.slice(1)}-${spanId}-01`],
    ["trailing data", `00-${traceId}-${spanId}-01-extra`],
    ["leading data", `x00-${traceId}-${spanId}-01`],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("writes the unsampled flag as 00", () => {
    expect(formatTraceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: false })).toBe(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-00`,
    );
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createTraceContext, formatTraceparent, parseTraceparent } from "./trace";

const hexId = (length: number) =>
  fc
    .string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: length, maxLength: length })
    .filter((id) => /[^0]/.test(id));

const nonZeroBytes = (length: number) =>
  fc.uint8Array({ minLength: length, maxLength: length }).filter((bytes) => bytes.some((byte) => byte !== 0));

/** Whether `value`, if accepted at all, has the version and ids its parsed form formats back to. */
function acceptedOnlyIfFaithful(value: string): boolean {
  const parsed = parseTraceparent(value);
  return parsed === null || value.slice(0, 53) === formatTraceparent(parsed).slice(0, 53);
}

/** A random source that hands out the given draws in order. */
function drawsInOrder(...draws: Uint8Array[]) {
  return () => {
    const next = draws.shift();
    if (next === undefined) throw new Error("random source exhausted");
    return next;
  };
}

describe("traceparent", () => {
  it("parses back exactly what it formats", () => {
    fc.assert(
      fc.property(hexId(32), hexId(16), fc.boolean(), (traceId, spanId, sampled) => {
        const context = { traceId, spanId, sampled };
        expect(parseTraceparent(formatTraceparent(context))).toStrictEqual(context);
      }),
    );
  });

  it("accepts only strings whose ids and version match the formatted context", () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), acceptedOnlyIfFaithful));
  });

  it("creates contexts that survive a round trip for any random draw", () => {
    fc.assert(
      fc.property(nonZeroBytes(16), nonZeroBytes(8), (traceBytes, spanBytes) => {
        const context = createTraceContext(drawsInOrder(traceBytes, spanBytes));
        expect(parseTraceparent(formatTraceparent(context))).toStrictEqual(context);
      }),
    );
  });
});

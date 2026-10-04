import fc from "fast-check";
import { describe, it } from "vitest";
import { createRedactor } from "./redact";

/** Tokens the host generates are base64url strings; secrets in this test have the same shape. */
const secret = fc.stringMatching(/^[A-Za-z0-9_-]{16,64}$/);

/** An arbitrary JSON-like value with `needle` embedded in strings and keys at random places. */
const valueContaining = (needle: string) =>
  fc.letrec<{ value: unknown }>((tie) => ({
    value: fc.oneof(
      { depthSize: "small" },
      fc.tuple(fc.string(), fc.string()).map(([before, after]) => `${before}${needle}${after}`),
      fc.string(),
      fc.integer(),
      fc.array(tie("value"), { maxLength: 4 }),
      fc.dictionary(fc.oneof(fc.string({ maxLength: 12 }), fc.constant(`key-${needle}`)), tie("value"), { maxKeys: 4 }),
    ),
  })).value;

/** Whether redacting `value` with `needle` as the known secret leaves no trace of it. */
function leavesNoTrace([needle, value]: readonly [string, unknown]): boolean {
  return !JSON.stringify(createRedactor(() => [needle])(value)).includes(needle);
}

describe("createRedactor", () => {
  it("never lets a known secret through, wherever it is placed", () => {
    fc.assert(
      fc.property(
        secret.chain((needle) => fc.tuple(fc.constant(needle), valueContaining(needle))),
        leavesNoTrace,
      ),
    );
  });
});

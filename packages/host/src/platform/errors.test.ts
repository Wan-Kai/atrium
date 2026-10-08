import { describe, expect, it } from "vitest";
import { errorCode } from "./errors";

describe("errorCode", () => {
  it("reads a system error's code", () => {
    expect(errorCode(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("ENOENT");
  });

  it.each([
    ["an error without a code", new Error("plain")],
    ["a code that is not a string", Object.assign(new Error("odd"), { code: 2 })],
    ["null", null],
    ["a string", "ENOENT"],
  ])("finds none in %s", (_case, error) => {
    expect(errorCode(error)).toBeUndefined();
  });
});

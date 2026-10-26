import { describe, expect, it } from "vitest";
import { errorCode } from "./errors";

describe("errorCode", () => {
  it("reads the code of an error and gives undefined for anything without one", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("ENOENT")).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});

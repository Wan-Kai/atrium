import { describe, expect, it } from "vitest";
import { tokensMatch } from "./auth";

describe("tokensMatch", () => {
  it("accepts the identical token", () => {
    expect(tokensMatch("a-long-secret-token", "a-long-secret-token")).toBe(true);
  });

  it.each([
    ["a different token of the same length", "a-long-secret-tokem"],
    ["a prefix", "a-long-secret"],
    ["a longer token", "a-long-secret-token-and-more"],
    ["an empty token", ""],
  ])("rejects %s", (_label, presented) => {
    expect(tokensMatch("a-long-secret-token", presented)).toBe(false);
  });
});

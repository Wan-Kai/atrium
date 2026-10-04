import { describe, expect, it } from "vitest";
import { isStrongToken, tokensMatch } from "./auth";

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

describe("isStrongToken", () => {
  it("accepts 32 random bytes in base64url", () => {
    expect(isStrongToken("a".repeat(43))).toBe(true);
    expect(isStrongToken("Az09_-".repeat(8))).toBe(true);
  });

  it.each([
    ["one character short", "a".repeat(42)],
    ["a character outside base64url at the end", `${"a".repeat(43)}+`],
    ["a character outside base64url at the start", `+${"a".repeat(43)}`],
    ["padding", `${"a".repeat(43)}=`],
    ["an empty token", ""],
  ])("rejects %s", (_label, token) => {
    expect(isStrongToken(token)).toBe(false);
  });
});

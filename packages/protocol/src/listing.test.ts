import { describe, expect, it } from "vitest";
import { Attention, isAuthFailure } from "./listing";

describe("isAuthFailure", () => {
  it.each([
    "No API key found for anthropic.",
    "OAuth refresh failed for anthropic: token refresh request failed",
    "HTTP 401 from the provider",
    "Unauthorized",
    "Authentication error",
    "Invalid API key",
    "invalid_api_key",
    "run /login first",
  ])("takes %j for a credentials problem", (text) => {
    expect(isAuthFailure(text)).toBe(true);
  });

  it.each(["Overloaded", "HTTP 4010 from the provider", "invalid api-key header", "429 Too Many Requests", ""])(
    "takes %j for something else",
    (text) => {
      expect(isAuthFailure(text)).toBe(false);
    },
  );
});

describe("Attention (protocol 32)", () => {
  it("refuses a text longer than 300 characters, and a mark without its text", () => {
    expect(Attention.safeParse({ reason: "error", at: 1, cleared: false, text: "x".repeat(301) }).success).toBe(false);
    expect(Attention.safeParse({ reason: "error", at: 1, cleared: false }).success).toBe(false);
  });
});

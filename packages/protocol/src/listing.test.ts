import { describe, expect, it } from "vitest";
import { isAuthFailure } from "./listing";

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

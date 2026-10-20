import { describe, expect, it } from "vitest";
import { isPiConfigValid } from "./validate-config";

describe("pi config syntax", () => {
  it("matches pi's models line comments and trailing commas without touching string literals", () => {
    expect(
      isPiConfigValid(
        "models.json",
        '\uFEFF{ // note\n "url": "https://example.test/a,}", "escaped": "\\\"//", "list": [1,], }',
      ),
    ).toBe(true);
    expect(isPiConfigValid("models.json", '{/* unsupported */ "providers": {}}')).toBe(false);
    expect(isPiConfigValid("settings.json", '{// no\n"x":1}')).toBe(false);
    expect(isPiConfigValid("models.json", "// comment only")).toBe(false);
  });

  it("accepts BOM and only pi settings may be empty", () => {
    expect(isPiConfigValid("settings.json", "")).toBe(true);
    for (const input of [" ", "\r\n", "\uFEFF", "\uFEFF \r\n"]) {
      expect(isPiConfigValid("settings.json", input)).toBe(false);
    }
    expect(isPiConfigValid("settings.json", "\uFEFF{}\n")).toBe(true);
    for (const name of ["models.json", "mcp.json", "keybindings.json"] as const) {
      expect(isPiConfigValid(name, "")).toBe(false);
      expect(isPiConfigValid(name, " \n")).toBe(false);
      expect(isPiConfigValid(name, "\uFEFF{}\n")).toBe(true);
    }
  });

  it("rejects malformed text and non-object roots in every ordinary file", () => {
    for (const name of ["settings.json", "models.json", "mcp.json", "keybindings.json"] as const) {
      for (const input of ["{", "null", "[]", "1", '"text"', " \uFEFF{}"])
        expect(isPiConfigValid(name, input)).toBe(false);
    }
  });
});

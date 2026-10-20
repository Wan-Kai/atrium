import { describe, expect, it } from "vitest";
import { allowsPermission } from "./permissions";

describe("allowsPermission", () => {
  it("lets the app's own page write the clipboard, and refuses everything else", () => {
    const page = "atrium://app/";
    expect([
      allowsPermission("clipboard-sanitized-write", "atrium://app/index.html", page),
      allowsPermission("clipboard-sanitized-write", "http://localhost:5173/", "http://localhost:5173/"),
      allowsPermission("clipboard-sanitized-write", "https://example.com/", page),
      allowsPermission("clipboard-sanitized-write", "atrium://other/", page),
      allowsPermission("clipboard-sanitized-write", "https://app/", page),
      allowsPermission("clipboard-sanitized-write", "not a url", page),
      allowsPermission("clipboard-read", "atrium://app/", page),
      allowsPermission("notifications", "atrium://app/", page),
      allowsPermission("media", "atrium://app/", page),
    ]).toStrictEqual([true, true, false, false, false, false, false, false, false]);
  });
});

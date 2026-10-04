import { describe, expect, it } from "vitest";
import { resolveStaticPath } from "./static-files";

const root = "/srv/ui";

describe("resolveStaticPath", () => {
  it.each([
    ["/", "/srv/ui/index.html"],
    ["/sessions/abc", "/srv/ui/index.html"],
    ["/assets/app.js", "/srv/ui/assets/app.js"],
    ["/assets/app.js?v=2", "/srv/ui/assets/app.js"],
  ])("maps %s to %s", (url, expected) => {
    expect(resolveStaticPath(root, url)).toBe(expected);
  });

  it.each([
    ["plain dot segments", "/../../secret.txt", "/srv/ui/secret.txt"],
    ["percent-encoded dot segments", "/%2e%2e/%2e%2e/secret.txt", "/srv/ui/secret.txt"],
    ["backslash dot segments", "/assets\\..\\..\\secret.txt", "/srv/ui/secret.txt"],
  ])("clamps %s to the root, as URL parsing normalizes them", (_label, url, expected) => {
    expect(resolveStaticPath(root, url)).toBe(expected);
  });

  it.each([
    ["an encoded slash that would climb out", "/assets/..%2f..%2fsecret.txt"],
    ["an encoded backslash", "/assets/..%5c..%5csecret.txt"],
    ["an encoded NUL", "/index.html%00.js"],
    ["malformed percent encoding", "/%E0%A4%A.js"],
    ["a sibling directory sharing the root's name as a prefix", "/..%2fui-private%2fkey.pem"],
  ])("refuses %s", (_label, url) => {
    expect(resolveStaticPath(root, url)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { MIN_PI_VERSION, isAtLeast, parseVersion } from "./version";

describe("parseVersion", () => {
  it.each([
    ["1.0.2", [1, 0, 2]],
    ["v1.0.2\n", [1, 0, 2]],
    ["pi 12.30.4-beta.1", [12, 30, 4]],
    ["1.0.12", [1, 0, 12]],
  ])("reads %j", (text, expected) => {
    expect(parseVersion(text)).toStrictEqual(expected);
  });

  it("returns null when there is no version", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("MIN_PI_VERSION", () => {
  it("accepts 1.0.1, the version pi-internals.md was verified against, and nothing older", () => {
    expect(isAtLeast([1, 0, 1], MIN_PI_VERSION)).toBe(true);
    expect(isAtLeast([1, 0, 0], MIN_PI_VERSION)).toBe(false);
  });
});

describe("isAtLeast", () => {
  it.each([
    [[1, 0, 1], [1, 0, 1], true],
    [[1, 0, 2], [1, 0, 1], true],
    [[1, 10, 0], [1, 9, 9], true],
    [[2, 0, 0], [1, 99, 99], true],
    [[1, 0, 0], [1, 0, 1], false],
    [[0, 99, 99], [1, 0, 0], false],
    [[1, 9, 9], [1, 10, 0], false],
    [[1, 2, 3], [1, 2, 4], false],
    [[1, 3, 0], [1, 2, 9], true],
  ] as const)("%j >= %j is %s", (version, minimum, expected) => {
    expect(isAtLeast(version, minimum)).toBe(expected);
  });
});

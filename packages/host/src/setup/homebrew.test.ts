import { createTempDir, present } from "@atrium/testkit";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { findHomebrew, withHomebrewOnPath } from "./homebrew";

/**
 * Makes directories, some holding a `brew`.
 *
 * @remarks
 * Stands in for PATH entries and Homebrew's places.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param names - The directories, and whether each has `brew`.
 * @returns A function giving a directory's path by name.
 */
async function dirs(names: Readonly<Record<string, boolean>>): Promise<(name: string) => string> {
  const root = await createTempDir("homebrew");
  onTestFinished(root.cleanup);
  const paths: Record<string, string> = {};
  for (const [name, hasBrew] of Object.entries(names)) {
    const path = join(root.path, name);
    await mkdir(path);
    if (hasBrew) {
      await writeFile(join(path, "brew"), "#!/bin/sh\n");
      await chmod(join(path, "brew"), 0o755);
    }
    paths[name] = path;
  }
  return (name) => present(paths[name], name);
}

describe("findHomebrew", () => {
  it("prefers the brew on PATH", async () => {
    const at = await dirs({ path: true, place: true });

    expect(await findHomebrew(at("path"), [at("place")])).toBe(join(at("path"), "brew"));
  });

  it("finds brew in its own place when PATH lacks it, trying the places in order", async () => {
    const at = await dirs({ path: false, empty: false, first: true, second: true });

    expect(await findHomebrew(at("path"), [at("empty"), at("first"), at("second")])).toBe(join(at("first"), "brew"));
  });

  it("finds nothing when there is no brew anywhere", async () => {
    const at = await dirs({ path: false, place: false });

    expect(await findHomebrew(at("path"), [at("place")])).toBeNull();
  });
});

describe("withHomebrewOnPath", () => {
  it("adds Homebrew's directory at the end of PATH when it was found elsewhere", () => {
    expect(withHomebrewOnPath({ PATH: "/usr/bin:/bin", HOME: "/h" }, "/opt/homebrew/bin/brew")).toStrictEqual({
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: "/h",
    });
    expect(withHomebrewOnPath({ PATH: "" }, "/opt/homebrew/bin/brew")).toStrictEqual({ PATH: "/opt/homebrew/bin" });
    expect(withHomebrewOnPath({}, "/opt/homebrew/bin/brew")).toStrictEqual({ PATH: "/opt/homebrew/bin" });
  });

  it("leaves the environment as it is when PATH has Homebrew or there is none", () => {
    const env = { PATH: "/usr/bin:/opt/homebrew/bin" };

    expect(withHomebrewOnPath(env, "/opt/homebrew/bin/brew")).toBe(env);
    expect(withHomebrewOnPath(env, null)).toBe(env);
  });
});

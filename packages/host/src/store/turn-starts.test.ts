import { createTempDir } from "@atrium/testkit";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadTurnStarts } from "./turn-starts";

/**
 * A home for one test.
 *
 * @remarks
 * Real files.
 *
 * @sideEffects Creates the directory, removed when the test ends.
 * @returns Its path.
 */
async function home(): Promise<string> {
  const dir = await createTempDir("turns");
  onTestFinished(dir.cleanup);
  return dir.path;
}

describe("loadTurnStarts", () => {
  it("starts empty, records new entries once each, and keeps them for the next host", async () => {
    const dir = await home();
    const { starts, setAside } = await loadTurnStarts(dir, "019a-session.1", 0);
    expect([...starts.opened]).toStrictEqual([]);
    expect(setAside).toBeNull();

    await starts.record(["u1", "u2"]);
    await starts.record(["u2", "u3"]);
    await starts.record(["u3"]);

    expect([...starts.opened]).toStrictEqual(["u1", "u2", "u3"]);
    expect(JSON.parse(await readFile(join(dir, "turns", "019a-session.1.json"), "utf8"))).toStrictEqual({
      version: 1,
      entries: ["u1", "u2", "u3"],
    });
    expect([...(await loadTurnStarts(dir, "019a-session.1", 0)).starts.opened]).toStrictEqual(["u1", "u2", "u3"]);
  });

  it.each([["../escape"], ["a/b"], [".hidden"], ["trailing-"], [""]])(
    "keeps the starts of a session whose id %s cannot name a file in memory only",
    async (sessionId) => {
      const dir = await home();
      const { starts } = await loadTurnStarts(dir, sessionId, 0);

      await starts.record(["u1"]);

      expect([...starts.opened]).toStrictEqual(["u1"]);
      expect(await readdir(dir)).toStrictEqual([]);
    },
  );

  it("starts a damaged file over, keeping it aside", async () => {
    const dir = await home();
    await loadTurnStarts(dir, "s1", 0).then(({ starts }) => starts.record(["u1"]));
    await writeFile(join(dir, "turns", "s1.json"), "{ damaged");

    const { starts, setAside } = await loadTurnStarts(dir, "s1", Date.UTC(2026, 9, 8));

    expect([...starts.opened]).toStrictEqual([]);
    expect(setAside).toBe(join(dir, "turns", "s1.corrupt-2026-10-08T00-00-00.000Z.json"));
  });
});

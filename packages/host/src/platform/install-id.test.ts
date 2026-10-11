import { createTempDir } from "@atrium/testkit";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readInstallSeed } from "./install-id";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
/** The first seven hex digits of {@link ID}, plus one. */
const SEED = 0x0f1e2d3 + 1;

/**
 * A home directory for one test.
 *
 * @remarks
 * Real files: the install id is one.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function homeDirectory(): Promise<string> {
  const home = await createTempDir("install-id");
  onTestFinished(home.cleanup);
  return home.path;
}

describe("readInstallSeed", () => {
  it("makes the install id the first time, readable only by the owner, and gives its seed", async () => {
    const home = await homeDirectory();

    const seed = await readInstallSeed(home, () => ID);

    expect(seed).toBe(SEED);
    expect(await readFile(join(home, "install-id"), "utf8")).toBe(`${ID}\n`);
    expect((await stat(join(home, "install-id"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the install id it has, so the seed stays the same", async () => {
    const home = await homeDirectory();
    await writeFile(join(home, "install-id"), ID.toUpperCase());

    const seed = await readInstallSeed(home, () => "11111111-2222-4333-8444-555555555555");

    expect(seed).toBe(SEED);
    expect(await readFile(join(home, "install-id"), "utf8")).toBe(ID.toUpperCase());
  });

  it("makes a new install id when the file holds something else", async () => {
    const home = await homeDirectory();
    await writeFile(join(home, "install-id"), "not an id\n");

    const seed = await readInstallSeed(home, () => ID);

    expect(seed).toBe(SEED);
    expect(await readFile(join(home, "install-id"), "utf8")).toBe(`${ID}\n`);
  });

  it("gives a seed of at least 1 for an id of zeros", async () => {
    const home = await homeDirectory();

    expect(await readInstallSeed(home, () => "00000000-0000-4000-8000-000000000000")).toBe(1);
  });
});

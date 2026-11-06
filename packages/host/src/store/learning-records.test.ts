import { createTempDir } from "@atrium/testkit";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadIndexFile } from "./index-file";
import { LEARNING_FILE } from "./index-schema";
import { createLearningRecords } from "./learning-records";

/**
 * An index directory for one test.
 *
 * @remarks
 * Real files, as everywhere in the store's tests.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function indexDirectory(): Promise<string> {
  const index = await createTempDir("learning-records");
  onTestFinished(index.cleanup);
  return index.path;
}

/**
 * Loads the records over `learning.json` in a directory.
 *
 * @remarks
 * Each call reads the file again, as a host starting does.
 *
 * @sideEffects Reads the file.
 * @param index - The directory.
 * @returns The records.
 */
async function recordsIn(index: string) {
  return createLearningRecords((await loadIndexFile(index, LEARNING_FILE, 0)).file);
}

describe("LearningRecords", () => {
  it("keeps a direction's name, pin and last opening in learning.json, each on its own", async () => {
    const index = await indexDirectory();
    const records = await recordsIn(index);
    expect(records.of("lrn_a")).toStrictEqual({ alias: null, pinnedAt: null, lastOpenedAt: null });

    await records.rename("lrn_a", "Node 后端");
    await records.pin("lrn_a", 10);
    await records.opened("lrn_b", 20);
    await records.opened("lrn_a", 30);

    expect(records.of("lrn_a")).toStrictEqual({ alias: "Node 后端", pinnedAt: 10, lastOpenedAt: 30 });
    expect(records.of("lrn_b")).toStrictEqual({ alias: null, pinnedAt: null, lastOpenedAt: 20 });
    const reloaded = await recordsIn(index);
    expect(reloaded.of("lrn_a")).toStrictEqual({ alias: "Node 后端", pinnedAt: 10, lastOpenedAt: 30 });
    expect(JSON.parse(await readFile(join(index, "learning.json"), "utf8"))).toStrictEqual({
      version: 1,
      directions: [
        { id: "lrn_b", lastOpenedAt: 20 },
        { id: "lrn_a", alias: "Node 后端", pinnedAt: 10, lastOpenedAt: 30 },
      ],
    });
  });

  it("drops a direction's record once nothing is left in it", async () => {
    const index = await indexDirectory();
    const records = await recordsIn(index);
    await records.rename("lrn_a", "后端");
    await records.pin("lrn_a", 5);

    await records.rename("lrn_a", null);
    await records.unpin("lrn_a");

    expect(records.of("lrn_a")).toStrictEqual({ alias: null, pinnedAt: null, lastOpenedAt: null });
    expect(JSON.parse(await readFile(join(index, "learning.json"), "utf8"))).toStrictEqual({
      version: 1,
      directions: [],
    });
  });

  it("keeps the first pin's time when pinned again, and writes nothing for what is already so", async () => {
    const index = await indexDirectory();
    const records = await recordsIn(index);

    await records.unpin("lrn_a");
    await records.rename("lrn_a", null);
    await expect(stat(join(index, "learning.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await records.pin("lrn_a", 5);
    await records.pin("lrn_a", 9);
    expect(records.of("lrn_a").pinnedAt).toBe(5);
  });

  it("keeps a record holding fields a newer Atrium wrote when its own last field is cleared", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "learning.json"),
      JSON.stringify({ version: 1, directions: [{ id: "lrn_a", alias: "旧名", colour: "teal" }] }),
    );
    const records = await recordsIn(index);

    await records.rename("lrn_a", null);

    expect(JSON.parse(await readFile(join(index, "learning.json"), "utf8"))).toStrictEqual({
      version: 1,
      directions: [{ id: "lrn_a", colour: "teal" }],
    });
  });

  it("gives no name a client could not take: empty or longer than 256 characters", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "learning.json"),
      JSON.stringify({
        version: 1,
        directions: [
          { id: "lrn_a", alias: "", pinnedAt: 3 },
          { id: "lrn_b", alias: "x".repeat(257) },
          { id: "lrn_c", alias: "y".repeat(256) },
        ],
      }),
    );
    const records = await recordsIn(index);

    expect(records.of("lrn_a")).toStrictEqual({ alias: null, pinnedAt: 3, lastOpenedAt: null });
    expect(records.of("lrn_b").alias).toBeNull();
    expect(records.of("lrn_c").alias).toBe("y".repeat(256));
  });

  it("keeps the fields a newer Atrium wrote in a direction's record", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "learning.json"),
      JSON.stringify({ version: 1, directions: [{ id: "lrn_a", alias: "旧名", colour: "teal" }], extra: 1 }),
    );
    const records = await recordsIn(index);

    await records.rename("lrn_a", "新名");

    expect(JSON.parse(await readFile(join(index, "learning.json"), "utf8"))).toStrictEqual({
      version: 1,
      directions: [{ id: "lrn_a", colour: "teal", alias: "新名" }],
      extra: 1,
    });
  });
});

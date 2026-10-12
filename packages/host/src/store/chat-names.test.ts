import { createTempDir } from "@atrium/testkit";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createChatNames } from "./chat-names";
import { loadIndexFile } from "./index-file";
import { CHATS_FILE } from "./index-schema";

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
  const index = await createTempDir("chat-names");
  onTestFinished(index.cleanup);
  return index.path;
}

describe("ChatNames", () => {
  it("keeps a chat's name in chats.json until it is cleared, leaving other chats' names alone", async () => {
    const index = await indexDirectory();
    const names = createChatNames((await loadIndexFile(index, CHATS_FILE, 0)).file);
    expect(names.alias("cht_a")).toBeNull();

    await names.rename("cht_a", "合并原理");
    await names.rename("cht_b", "周报");
    await names.rename("cht_a", "merge-tree");
    // The same name as another chat's is a change all the same.
    await names.rename("cht_c", "周报");

    expect([names.alias("cht_a"), names.alias("cht_b"), names.alias("cht_c")]).toStrictEqual([
      "merge-tree",
      "周报",
      "周报",
    ]);
    const reloaded = createChatNames((await loadIndexFile(index, CHATS_FILE, 0)).file);
    expect([reloaded.alias("cht_a"), reloaded.alias("cht_b")]).toStrictEqual(["merge-tree", "周报"]);

    await names.rename("cht_a", null);

    expect([names.alias("cht_a"), names.alias("cht_b")]).toStrictEqual([null, "周报"]);
    expect(JSON.parse(await readFile(join(index, "chats.json"), "utf8"))).toStrictEqual({
      version: 1,
      chats: [
        { id: "cht_b", alias: "周报" },
        { id: "cht_c", alias: "周报" },
      ],
    });
  });

  it("writes nothing when the name stays as it is", async () => {
    const index = await indexDirectory();
    const names = createChatNames((await loadIndexFile(index, CHATS_FILE, 0)).file);

    await names.rename("cht_a", null);

    await expect(stat(join(index, "chats.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

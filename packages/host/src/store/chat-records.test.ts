import { createTempDir } from "@atrium/testkit";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createChatRecords, listChats } from "./chat-records";
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
  const index = await createTempDir("chat-records");
  onTestFinished(index.cleanup);
  return index.path;
}

describe("ChatRecords", () => {
  it("keeps a chat's name in chats.json until it is cleared, leaving other chats' names alone", async () => {
    const index = await indexDirectory();
    const names = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
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
    const reloaded = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
    expect([reloaded.alias("cht_a"), reloaded.alias("cht_b")]).toStrictEqual(["merge-tree", "周报"]);

    await names.rename("cht_a", null);

    expect([names.alias("cht_a"), names.alias("cht_b")]).toStrictEqual([null, "周报"]);
    expect(JSON.parse(await readFile(join(index, "chats.json"), "utf8"))).toStrictEqual({
      version: 2,
      chats: [
        { id: "cht_b", alias: "周报" },
        { id: "cht_c", alias: "周报" },
      ],
    });
  });

  it("writes nothing when the name stays as it is", async () => {
    const index = await indexDirectory();
    const names = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);

    await names.rename("cht_a", null);

    await expect(stat(join(index, "chats.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a chat's archive in chats.json beside its name until it is restored", async () => {
    const index = await indexDirectory();
    const records = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
    const archive = { at: 1_700_000_000_000, sessions: ["s1", "s2"], first: "s1" };
    expect(records.archived("cht_a")).toBeNull();

    await records.rename("cht_a", "合并原理");
    await records.setArchived("cht_a", archive);
    await records.setArchived("cht_b", { at: 5, sessions: [], first: null });
    await records.rename("cht_a", "merge-tree");

    expect([records.archived("cht_a"), records.alias("cht_a"), records.archived("cht_b")]).toStrictEqual([
      archive,
      "merge-tree",
      { at: 5, sessions: [], first: null },
    ]);
    const reloaded = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
    expect([reloaded.archived("cht_a"), reloaded.alias("cht_b")]).toStrictEqual([archive, null]);

    await records.rename("cht_b", "周报");
    await records.setArchived("cht_b", null);
    await records.setArchived("cht_a", null);
    await records.rename("cht_b", null);

    expect([records.archived("cht_a"), records.alias("cht_a"), records.archived("cht_b")]).toStrictEqual([
      null,
      "merge-tree",
      null,
    ]);
    expect(JSON.parse(await readFile(join(index, "chats.json"), "utf8"))).toStrictEqual({
      version: 2,
      chats: [{ id: "cht_a", alias: "merge-tree" }],
    });
  });

  it("writes nothing when the archive stays as it is", async () => {
    const index = await indexDirectory();
    const records = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);

    await records.setArchived("cht_a", null);

    await expect(stat(join(index, "chats.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await records.setArchived("cht_a", { at: 5, sessions: ["s1"], first: "s1" });
    await rm(join(index, "chats.json"));
    await records.setArchived("cht_a", { at: 5, sessions: ["s1"], first: "s1" });
    await expect(stat(join(index, "chats.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the fields of a record a newer Atrium wrote", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "chats.json"),
      JSON.stringify({ version: 2, chats: [{ id: "cht_a", alias: "合并原理", pinned: true }] }),
    );
    const records = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);

    await records.setArchived("cht_a", { at: 5, sessions: [], first: null });

    expect(JSON.parse(await readFile(join(index, "chats.json"), "utf8"))).toStrictEqual({
      version: 2,
      chats: [{ id: "cht_a", alias: "合并原理", pinned: true, archived: { at: 5, sessions: [], first: null } }],
    });
  });

  it("reads version 1's names as they were", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "chats.json"),
      JSON.stringify({ version: 1, chats: [{ id: "cht_a", alias: "合并原理" }] }),
    );

    const records = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);

    expect([records.alias("cht_a"), records.archived("cht_a")]).toStrictEqual(["合并原理", null]);
  });

  it("lists chats with their names and archives, an archived chat keeping the first session it had", async () => {
    const index = await indexDirectory();
    const records = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
    await records.rename("cht_a", "合并原理");
    await records.setArchived("cht_b", { at: 7, sessions: ["s2", "s3"], first: "s2" });

    expect(
      listChats(
        [
          { id: "cht_a", dir: "/chats/a", firstSessionId: "s1" },
          { id: "cht_b", dir: "/chats/b", firstSessionId: null },
        ],
        records,
      ),
    ).toStrictEqual([
      { id: "cht_a", dir: "/chats/a", alias: "合并原理", firstSessionId: "s1", archivedAt: null },
      { id: "cht_b", dir: "/chats/b", alias: null, firstSessionId: "s2", archivedAt: 7 },
    ]);
  });
});

import { createTempDir } from "@atrium/testkit";
import { mkdir, readFile, readdir, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { IndexTooNewError, type IndexFileSpec, loadIndexFile, writeAtomically } from "./index-file";

const Item = z.looseObject({ name: z.string() });
const Document = z.looseObject({ items: z.array(Item) });
type Document = z.infer<typeof Document>;

/** A spec at version 3, whose older versions kept a single `item` (v1) or `names` (v2). */
const spec: IndexFileSpec<Document> = {
  name: "things",
  version: 3,
  schema: Document,
  empty: () => ({ items: [] }),
  migrations: {
    1: ({ item, ...rest }) => ({ ...rest, names: [item] }),
    2: ({ names, ...rest }) => ({ ...rest, items: (names as string[]).map((name) => ({ name })) }),
  },
};

const NOW = Date.UTC(2026, 9, 8, 1, 2, 3, 4);

/**
 * Creates an index directory for one test.
 *
 * @remarks
 * Real files, as everywhere in the store's tests.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function indexDirectory(): Promise<string> {
  const dir = await createTempDir("index");
  onTestFinished(dir.cleanup);
  return dir.path;
}

describe("loadIndexFile", () => {
  it("starts a missing file empty, without writing it", async () => {
    const directory = await indexDirectory();

    const { file, setAside } = await loadIndexFile(directory, spec, NOW);

    expect(file.read()).toStrictEqual({ items: [] });
    expect(setAside).toBeNull();
    expect(await readdir(directory)).toStrictEqual([]);
  });

  it("saves the document with its version, readable only by the owner, and loads it back", async () => {
    const directory = await indexDirectory();
    const { file } = await loadIndexFile(directory, spec, NOW);

    await file.save({ items: [{ name: "a" }] });

    const path = join(directory, "things.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual({ version: 3, items: [{ name: "a" }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(file.read()).toStrictEqual({ items: [{ name: "a" }] });
    expect((await loadIndexFile(directory, spec, NOW)).file.read()).toStrictEqual({ items: [{ name: "a" }] });
  });

  it("keeps fields it does not know when it rewrites a file", async () => {
    const directory = await indexDirectory();
    const path = join(directory, "things.json");
    await writeFile(path, JSON.stringify({ version: 3, items: [{ name: "a", pinned: true }], layout: "grid" }));
    const { file } = await loadIndexFile(directory, spec, NOW);

    const document = file.read();
    await file.save({ ...document, items: [...document.items, { name: "b" }] });

    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual({
      version: 3,
      items: [{ name: "a", pinned: true }, { name: "b" }],
      layout: "grid",
    });
  });

  it("upgrades an older version step by step, keeping the original as a backup", async () => {
    const directory = await indexDirectory();
    const original = JSON.stringify({ version: 1, item: "a" });
    await writeFile(join(directory, "things.json"), original);

    const { file, setAside } = await loadIndexFile(directory, spec, NOW);

    expect(file.read()).toStrictEqual({ items: [{ name: "a" }] });
    expect(setAside).toBeNull();
    expect(await readFile(join(directory, "things.v1.bak"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(join(directory, "things.json"), "utf8"))).toStrictEqual({
      version: 3,
      items: [{ name: "a" }],
    });
  });

  it("refuses a newer version and leaves the file alone", async () => {
    const directory = await indexDirectory();
    const path = join(directory, "things.json");
    const newer = JSON.stringify({ version: 4, items: "a new shape" });
    await writeFile(path, newer);

    const loading = loadIndexFile(directory, spec, NOW);

    await expect(loading).rejects.toThrow(IndexTooNewError);
    await expect(loading).rejects.toMatchObject({ path, version: 4, supported: 3 });
    expect(await readdir(directory)).toStrictEqual(["things.json"]);
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it.each([
    ["text that is not JSON", "{ items: "],
    ["JSON that is not an object", "[1, 2]"],
    ["JSON null", "null"],
    ["no version", JSON.stringify({ items: [] })],
    ["a version that is not a number", JSON.stringify({ version: "3", items: [] })],
    ["a version below 1", JSON.stringify({ version: 0, items: [] })],
    ["a version that is not whole", JSON.stringify({ version: 2.5, items: [] })],
    ["a version that is not whole, past the latest", JSON.stringify({ version: 3.5, items: [] })],
    ["a document the schema rejects", JSON.stringify({ version: 3, items: [{ name: 1 }] })],
    ["an older version with no upgrade from it", JSON.stringify({ version: 1, item: "a" })],
  ])("sets aside %s and starts empty", async (_case, text) => {
    const directory = await indexDirectory();
    await writeFile(join(directory, "things.json"), text);
    const partial = { ...spec, migrations: { 2: (document: Record<string, unknown>) => ({ ...document, items: [] }) } };

    const { file, setAside } = await loadIndexFile(directory, partial, NOW);

    const aside = join(directory, "things.corrupt-2026-10-08T01-02-03.004Z.json");
    expect(setAside).toBe(aside);
    expect(file.read()).toStrictEqual({ items: [] });
    expect(await readdir(directory)).toStrictEqual(["things.corrupt-2026-10-08T01-02-03.004Z.json"]);
    expect(await readFile(aside, "utf8")).toBe(text);
  });

  it("sets aside a version below 1 even when there is an upgrade from it", async () => {
    const directory = await indexDirectory();
    await writeFile(join(directory, "things.json"), JSON.stringify({ version: 0, item: "a" }));
    const fromZero = {
      ...spec,
      migrations: { ...spec.migrations, 0: (document: Record<string, unknown>) => document },
    };

    const { file, setAside } = await loadIndexFile(directory, fromZero, NOW);

    expect(setAside).toBe(join(directory, "things.corrupt-2026-10-08T01-02-03.004Z.json"));
    expect(file.read()).toStrictEqual({ items: [] });
  });

  it("sets aside an older version when the spec has no upgrades at all", async () => {
    const directory = await indexDirectory();
    await writeFile(join(directory, "things.json"), JSON.stringify({ version: 2, names: ["a"] }));
    const bare: IndexFileSpec<Document> = {
      name: "things",
      version: 3,
      schema: Document,
      empty: () => ({ items: [] }),
    };

    const { file, setAside } = await loadIndexFile(directory, bare, NOW);

    expect(setAside).toBe(join(directory, "things.corrupt-2026-10-08T01-02-03.004Z.json"));
    expect(file.read()).toStrictEqual({ items: [] });
  });

  it("names a file in a subdirectory by its path", async () => {
    const directory = await indexDirectory();
    const { file } = await loadIndexFile(directory, { ...spec, name: "turns/s1" }, NOW);

    await file.save({ items: [{ name: "a" }] });

    expect((await stat(join(directory, "turns"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(directory, "turns", "s1.json"), "utf8"))).toStrictEqual({
      version: 3,
      items: [{ name: "a" }],
    });
  });

  it("throws read errors other than a missing file", async () => {
    const directory = await indexDirectory();
    await mkdir(join(directory, "things.json"));

    await expect(loadIndexFile(directory, spec, NOW)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("IndexFile.save", () => {
  it("writes only the latest of the documents saved during a write, and settles them together", async () => {
    const directory = await indexDirectory();
    const { file } = await loadIndexFile(directory, spec, NOW);

    const first = file.save({ items: [{ name: "a" }] });
    const second = file.save({ items: [{ name: "b" }] });
    const third = file.save({ items: [{ name: "c" }] });

    expect(second).toBe(first);
    expect(third).toBe(first);
    await third;
    expect(JSON.parse(await readFile(join(directory, "things.json"), "utf8"))).toStrictEqual({
      version: 3,
      items: [{ name: "c" }],
    });
  });

  it("rejects a failed write, which flush waits for without failing, leaves no temporary file, and writes again on the next save", async () => {
    const directory = await indexDirectory();
    const { file } = await loadIndexFile(directory, spec, NOW);
    const path = join(directory, "things.json");
    await mkdir(path);

    const saving = file.save({ items: [{ name: "a" }] });
    await file.flush();

    await expect(saving).rejects.toMatchObject({ syscall: "rename" });
    expect(await readdir(directory)).toStrictEqual(["things.json"]);
    await rmdir(path);
    await file.save({ items: [{ name: "b" }] });
    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual({ version: 3, items: [{ name: "b" }] });
  });

  it("flushes by waiting for the write in progress", async () => {
    const directory = await indexDirectory();
    const { file } = await loadIndexFile(directory, spec, NOW);

    // Fire and forget: `flush` below waits for it.
    void file.save({ items: [{ name: "a" }] });
    await file.flush();

    expect(JSON.parse(await readFile(join(directory, "things.json"), "utf8"))).toStrictEqual({
      version: 3,
      items: [{ name: "a" }],
    });
  });
});

describe("writeAtomically", () => {
  it("replaces a file's content whole", async () => {
    const directory = await indexDirectory();
    const path = join(directory, "file.json");
    await writeFile(path, "old");

    await writeAtomically(path, "new");

    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(directory)).toStrictEqual(["file.json"]);
  });
});

/**
 * A writer whose first write fails, as when the disk is briefly full.
 *
 * @remarks
 * Records what the later writes put on disk.
 *
 * @sideEffects Writes files after the first call.
 * @param written - Where the written contents go.
 * @returns The writer.
 */
function failingFirst(written: string[]): (path: string, content: string) => Promise<void> {
  let failed = false;
  return async (path, content) => {
    if (!failed) {
      failed = true;
      throw new Error("disk full");
    }
    written.push(content);
    await writeAtomically(path, content);
  };
}

describe("IndexFile.save after a failed write", () => {
  it("still writes a document saved while a write was failing", async () => {
    const directory = await indexDirectory();
    const written: string[] = [];
    const { file } = await loadIndexFile(directory, spec, NOW, failingFirst(written));

    const first = file.save({ items: [{ name: "a" }] });
    const second = file.save({ items: [{ name: "b" }] });

    await expect(second).resolves.toBeUndefined();
    expect(second).toBe(first);
    expect(written.map((content) => JSON.parse(content))).toStrictEqual([{ version: 3, items: [{ name: "b" }] }]);
  });
});

import { createTempDir } from "@atrium/testkit";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { MARKER } from "./directions";
import { STUDY_VERSION, parseStudyFile } from "./progress";
import { StudyFileError, createProgressFiles } from "./progress-file";

/** A file as the discussion's start leaves it, with a field Atrium does not know at every level. */
const FILE = {
  version: 1,
  name: "Go",
  createdAt: "2026-11-09T00:00:00.000Z",
  mine: { a: 1 },
  ladder: [
    { id: "l1", name: "a", topics: "", pass: "", state: "current", note: "x" },
    { id: "l2", name: "b", topics: "", pass: "", state: "todo" },
  ],
  steps: { l1: [{ id: "s1", kind: "lesson", title: "t", lesson: null, quiz: null, done: null, extra: [1] }] },
  gaps: [{ id: "g1", text: "x", from: { level: "l1", step: "s1", by: "me" }, fixed: null, seen: true }],
  finishedAt: null,
};

/**
 * A direction's directory with a marker holding `content`, and the files to change it with.
 *
 * @remarks
 * A real directory right under a learning directory; the random part of the temporary name is
 * fixed unless `random` is given.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @param content - The marker's text, or a value written as JSON.
 * @param random - The temporary file's random part.
 * @returns The learning directory, the direction's, the files and the logs.
 */
async function direction(content: unknown, random: () => string = () => "r") {
  const temp = await createTempDir("progress");
  onTestFinished(temp.cleanup);
  const root = join(await realpath(temp.path), "Learning");
  const dir = join(root, "go");
  await mkdir(dir, { recursive: true });
  if (content !== undefined) {
    await writeFile(join(dir, MARKER), typeof content === "string" ? content : JSON.stringify(content));
  }
  const { logger, records } = recordingTracing();
  return { root, dir, files: createProgressFiles({ root, random, logger }), logs: records };
}

/** The marker's content now, parsed. */
async function marker(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, MARKER), "utf8"));
}

/** The code of the error an update rejects with. */
async function code(update: Promise<unknown>): Promise<string> {
  try {
    await update;
  } catch (error) {
    if (error instanceof StudyFileError) return error.code;
    throw error;
  }
  throw new Error("not refused");
}

describe("ProgressFiles", () => {
  it("reads the file again, changes it and writes it whole, keeping fields it does not know", async () => {
    const { dir, files } = await direction(FILE);
    await writeFile(join(dir, MARKER), JSON.stringify({ ...FILE, name: "Go 并发" }));
    const written = await files.update(dir, (file) => ({ ...file, gaps: [] }));
    const { gaps: _gaps, ...rest } = FILE;

    expect(await marker(dir)).toStrictEqual({ ...rest, name: "Go 并发", gaps: [] });
    expect(written).toStrictEqual(parseStudyFile(JSON.stringify({ ...rest, name: "Go 并发", gaps: [] })));
    expect((await readFile(join(dir, MARKER), "utf8")).endsWith("}\n")).toBe(true);
    expect(await readdir(dir)).toStrictEqual([MARKER]);
    expect(STUDY_VERSION).toBe(1);
  });

  it("does not write a broken file, nor one of a later version", async () => {
    for (const content of [
      "not json",
      { ...FILE, ladder: [FILE.ladder[0]] },
      { ...FILE, ladder: Array.from({ length: 7 }, (_, at) => ({ ...FILE.ladder[1], id: `l${String(at)}` })) },
      { ...FILE, steps: { l9: [] } },
      { ...FILE, gaps: [FILE.gaps[0], FILE.gaps[0]] },
      { ...FILE, version: "1" },
      [],
    ]) {
      const { dir, files } = await direction(content);
      const before = await readFile(join(dir, MARKER), "utf8");

      expect(await code(files.update(dir, (file) => file))).toBe("study_file_broken");
      expect(await readFile(join(dir, MARKER), "utf8")).toBe(before);
    }
    const { dir, files } = await direction({ ...FILE, version: 2 });

    expect(await code(files.update(dir, (file) => file))).toBe("study_file_version");
    expect(await marker(dir)).toStrictEqual({ ...FILE, version: 2 });
  });

  it("does not read or write through a link, nor a file too large or missing", async () => {
    const { dir, files } = await direction(undefined);

    expect(await code(files.update(dir, (file) => file))).toBe("study_file_broken");
    const other = await direction(FILE);
    await symlink(join(other.dir, MARKER), join(dir, MARKER));

    expect(await code(files.update(dir, (file) => ({ ...file, name: "x" })))).toBe("study_file_broken");
    expect(await marker(other.dir)).toStrictEqual(FILE);
    const large = await direction(JSON.stringify({ ...FILE, pad: "x".repeat(1024 * 1024) }));

    expect(await code(large.files.update(large.dir, (file) => file))).toBe("study_file_broken");
  });

  it("writes one change at a time, each on the one before", async () => {
    const { dir, files } = await direction(
      FILE,
      (() => {
        let next = 0;
        return () => String((next += 1));
      })(),
    );
    await Promise.all(
      ["a", "b", "c"].map((name) => files.update(dir, (file) => ({ ...file, name: `${file.name}${name}` }))),
    );

    expect(await marker(dir)).toMatchObject({ name: "Goabc" });
    expect(await readdir(dir)).toStrictEqual([MARKER]);
  });

  it("passes a change's refusal on, writing nothing, and goes on with the next", async () => {
    const { dir, files } = await direction(FILE);
    const refused = files.update(dir, () => {
      throw new Error("refused");
    });

    await expect(refused).rejects.toThrow("refused");
    await files.update(dir, (file) => ({ ...file, name: "next" }));

    expect(await marker(dir)).toMatchObject({ name: "next" });
  });

  it("refuses to write a change the file would not read back as, and leaves no temporary file", async () => {
    const { dir, files, logs } = await direction(FILE);

    expect(await code(files.update(dir, (file) => ({ ...file, name: "" })))).toBe("study_write_failed");
    expect(await marker(dir)).toStrictEqual(FILE);
    expect(await readdir(dir)).toStrictEqual([MARKER]);
    const taken = await direction(FILE);
    await writeFile(join(taken.dir, `${MARKER}.r.tmp`), "someone's");

    expect(await code(taken.files.update(taken.dir, (file) => ({ ...file, name: "x" })))).toBe("study_write_failed");
    expect(await readFile(join(taken.dir, `${MARKER}.r.tmp`), "utf8")).toBe("someone's");
    expect(await marker(taken.dir)).toStrictEqual(FILE);
    expect(logs.filter((record) => record["msg"] === "study file not written")).toHaveLength(1);
  });

  it("waits for writes under way when closed", async () => {
    const { dir, files } = await direction(FILE);
    let written = false;
    const update = files.update(dir, (file) => ({ ...file, name: "closing" }));
    void update.finally(() => {
      written = true;
    });
    await files.close();

    expect(written).toBe(true);
    await expect(update).resolves.toMatchObject({ name: "closing" });
  });

  it("removes its temporary file when the rename fails, and logs the failure's code only", async () => {
    const { dir, files, logs } = await direction(FILE);

    expect(
      await code(
        files.update(dir, (file) => {
          // Something put where the marker was between the read and the write.
          rmSync(join(dir, MARKER));
          mkdirSync(join(dir, MARKER, "inside"), { recursive: true });
          return file;
        }),
      ),
    ).toBe("study_write_failed");
    expect((await readdir(dir)).toSorted()).toStrictEqual([MARKER]);
    expect(logs.filter((record) => record["msg"] === "study file not written")).toMatchObject([
      { code: expect.stringMatching(/^E[A-Z]+$/u) },
    ]);
  });

  it("logs a change that would not read back as such", async () => {
    const { dir, files, logs } = await direction(FILE);
    await code(files.update(dir, (file) => ({ ...file, name: "" })));

    expect(logs.filter((record) => record["msg"] === "study file not written")).toMatchObject([
      { code: "study_write_failed" },
    ]);
  });

  it("reads a file of exactly the limit, and not one a byte over", async () => {
    const limit = 1024 * 1024;
    const base = JSON.stringify({ ...FILE, pad: "" });
    const exact = await direction(JSON.stringify({ ...FILE, pad: "x".repeat(limit - base.length) }));

    // Read, then refused for writing it back indented, larger than a read takes.
    expect(await code(exact.files.update(exact.dir, (file) => file))).toBe("study_file_too_large");
    const over = await direction(JSON.stringify({ ...FILE, pad: "x".repeat(limit - base.length + 1) }));

    expect(await code(over.files.update(over.dir, (file) => file))).toBe("study_file_broken");
  });

  it("refuses a direction's directory swapped for a link after the scan, writing nothing through it", async () => {
    const { root, dir, files } = await direction(FILE);
    const elsewhere = join(root, "..", "elsewhere");
    await rename(dir, elsewhere);
    await symlink(elsewhere, dir);

    expect(await code(files.update(dir, (file) => ({ ...file, name: "through" })))).toBe("learning_dir_unsafe");
    expect(await marker(elsewhere)).toStrictEqual(FILE);
    // A real directory, but not right under the learning directory.
    const nested = join(root, "a", "go");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, MARKER), JSON.stringify(FILE));

    expect(await code(files.update(nested, (file) => ({ ...file, name: "deep" })))).toBe("learning_dir_unsafe");
    expect(await marker(nested)).toStrictEqual(FILE);
  });

  it("holds a direction for an archive: the changes before it first, those asked meanwhile refused", async () => {
    const { dir, files } = await direction(FILE);
    const order: string[] = [];
    const before = files.update(dir, (file) => {
      order.push("before");
      return { ...file, name: "before" };
    });
    const archive = files.hold(dir, async () => {
      order.push("archive");
      expect((await readdir(dir)).toSorted()).toStrictEqual([MARKER]);
      return "moved";
    });
    const during = files.update(dir, (file) => ({ ...file, name: "during" }));

    expect(await code(during)).toBe("direction_archived");
    await expect(archive).resolves.toBe("moved");
    await expect(before).resolves.toMatchObject({ name: "before" });
    expect(order).toStrictEqual(["before", "archive"]);
    // Once it is over, the direction takes changes again, as after a restore.
    await expect(files.update(dir, (file) => ({ ...file, name: "after" }))).resolves.toMatchObject({ name: "after" });
  });

  it("lets a failed hold go, refusing nothing after it", async () => {
    const { dir, files } = await direction(FILE);

    await expect(files.hold(dir, () => Promise.reject(new Error("place taken")))).rejects.toThrow("place taken");
    await expect(files.update(dir, (file) => ({ ...file, name: "after" }))).resolves.toMatchObject({ name: "after" });
  });

  it("writes a change of exactly the size a read takes", async () => {
    const { dir, files } = await direction(FILE);
    const base = `${JSON.stringify({ ...FILE, pad: "" }, null, 2)}\n`.length;

    await expect(
      files.update(dir, (file) => ({ ...file, pad: "x".repeat(1024 * 1024 - base) })),
    ).resolves.toMatchObject({ name: "Go" });
    expect((await readFile(join(dir, MARKER))).length).toBe(1024 * 1024);
  });

  it("refuses a change that would not be read back for its size, writing nothing", async () => {
    const { dir, files, logs } = await direction(FILE);
    expect(await code(files.update(dir, (file) => ({ ...file, pad: "x".repeat(1024 * 1024) })))).toBe(
      "study_file_too_large",
    );
    expect(await marker(dir)).toStrictEqual(FILE);
    expect(await readdir(dir)).toStrictEqual([MARKER]);
    expect(logs.filter((record) => record["msg"] === "study file not written")).toMatchObject([
      { code: "study_file_too_large" },
    ]);
  });
});

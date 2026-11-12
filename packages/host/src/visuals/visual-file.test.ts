import { CommandError } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { chmod, lstat, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkVisual, readVisual } from "./visual-file";

/**
 * A session's working directory with its visuals directory inside, as a study direction has.
 *
 * @remarks
 * Real files; the directory is resolved, as macOS's temporary directory is a link.
 *
 * @sideEffects Creates the directories, removed when the test ends.
 * @returns The working directory and the visuals directory.
 */
async function place(): Promise<{ cwd: string; dir: string }> {
  const temp = await createTempDir("visuals");
  onTestFinished(temp.cleanup);
  const cwd = await realpath(temp.path);
  const dir = join(cwd, "visuals");
  await mkdir(dir);
  return { cwd, dir };
}

/**
 * The error code a check fails with.
 *
 * @remarks
 * Every refusal is a `CommandError`; anything else is a bug the test should see.
 *
 * @sideEffects none
 * @param check - The failing check.
 * @returns The code.
 */
async function refusal(check: Promise<unknown>): Promise<string> {
  try {
    await check;
  } catch (error) {
    if (error instanceof CommandError) return error.code;
    throw error;
  }
  throw new Error("the check passed");
}

/**
 * Swaps a checked folder for a link to the outside the first time it runs, as a racing process would.
 *
 * @remarks
 * Given to a check as what runs between its checks and its opening.
 *
 * @sideEffects Renames the folder and makes the link, once.
 * @param folder - The folder inside.
 * @param outside - Where the link points.
 * @returns The swap.
 */
function swapOnce(folder: string, outside: string): () => Promise<void> {
  let swapped = false;
  return async () => {
    if (swapped) return;
    swapped = true;
    await rename(folder, `${folder}-real`);
    await symlink(outside, folder);
  };
}

/**
 * Checks or reads a direction's `visuals/a.html`, with its rules.
 *
 * @remarks
 * Both go through the same opening, and both must refuse a swap (security.md, "渲染内容").
 *
 * @sideEffects Opens and closes the file.
 * @param way - Whether to check it, as a resolve does, or read it, as a page request does.
 * @param now - The direction's directory.
 * @param dir - Its `visuals/`.
 * @param beforeOpen - What runs between the checks and the opening.
 * @param owned - The direction's check.
 * @returns What the check or the read gives.
 */
function attempt(
  way: "check" | "read",
  now: string,
  dir: string,
  beforeOpen: (() => Promise<void>) | undefined,
  owned: () => Promise<boolean>,
): Promise<unknown> {
  return way === "read"
    ? readVisual(dir, join(dir, "a.html"), beforeOpen, owned)
    : checkVisual(dir, now, "visuals/a.html", beforeOpen, { owned });
}

/**
 * Whether a path is a folder and no link.
 *
 * @remarks
 * As the host's check of a direction's place.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether.
 */
async function isRealFolder(path: string): Promise<boolean> {
  const info = await lstat(path);
  return info.isDirectory() && !info.isSymbolicLink();
}

/**
 * A folder beside the direction's with the same `visuals/a.html`, holding other text.
 *
 * @remarks
 * Where a swapped direction would lead.
 *
 * @sideEffects Creates the folder and the file.
 * @param now - The direction's directory.
 * @returns The folder.
 */
async function sameVisualElsewhere(now: string): Promise<string> {
  const elsewhere = join(now, "..", "..", "elsewhere");
  await mkdir(join(elsewhere, "visuals"), { recursive: true });
  await writeFile(join(elsewhere, "visuals", "a.html"), "outside");
  return elsewhere;
}

/**
 * A direction's check that passes, then leaves the direction a link to elsewhere, and on its second
 * call puts the direction back and passes again, as a racing process would.
 *
 * @remarks
 * The swap lands right after the first check, the swap back once the file is open.
 *
 * @sideEffects Renames the direction and makes and removes the link.
 * @param now - The direction's directory.
 * @param elsewhere - Where the link points.
 * @returns The check, and how many times it ran.
 */
function swapThenBack(now: string, elsewhere: string): (() => Promise<boolean>) & { calls: () => number } {
  let calls = 0;
  const steps = [
    async () => {
      await rename(now, `${now}-real`);
      await symlink(elsewhere, now);
    },
    async () => {
      await rm(now);
      await rename(`${now}-real`, now);
    },
  ];
  const check = async () => {
    await steps[calls]?.();
    calls += 1;
    return true;
  };
  return Object.assign(check, { calls: () => calls });
}

describe("checkVisual", () => {
  it("finds a visual by a path relative to the working directory, or absolute in the directory", async () => {
    const { cwd, dir } = await place();
    await mkdir(join(dir, "lesson-2"));
    await writeFile(join(dir, "lesson-2", "isolation.html"), "<div id=a></div>");

    const relative = await checkVisual(dir, cwd, "visuals/lesson-2/isolation.html");
    const absolute = await checkVisual(dir, "/elsewhere", join(dir, "lesson-2", "isolation.html"));

    expect(relative).toStrictEqual({ file: join(dir, "lesson-2", "isolation.html"), size: 16, mtime: relative.mtime });
    expect(absolute).toStrictEqual(relative);
    expect(Number.isInteger(relative.mtime)).toBe(true);
    expect(relative.mtime).toBeGreaterThan(0);
  });

  it("refuses anything outside the directory, not .html, or not a plain file", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(cwd, "secret.html"), "x");
    await writeFile(join(dir, "notes.txt"), "x");
    await mkdir(join(dir, "folder.html"));
    await writeFile(join(dir, "page.html.txt"), "x");

    for (const path of [
      "secret.html",
      join(cwd, "secret.html"),
      "visuals/../secret.html",
      join(dir, "..", "secret.html"),
      "visuals/notes.txt",
      "visuals/folder.html",
      "visuals/page.html.txt",
      "visuals",
      dir,
    ]) {
      expect([path, await refusal(checkVisual(dir, cwd, path))]).toStrictEqual([path, "visual_outside"]);
    }
  });

  it("refuses a link on the way, to a file or a folder, even one pointing inside", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(cwd, "secret.html"), "x");
    await writeFile(join(dir, "real.html"), "x");
    await symlink(join(cwd, "secret.html"), join(dir, "out.html"));
    await symlink(join(dir, "real.html"), join(dir, "in.html"));
    await symlink(cwd, join(dir, "up"));

    for (const path of [
      "visuals/out.html",
      "visuals/in.html",
      "visuals/up/secret.html",
      "visuals/up/visuals/real.html",
    ]) {
      expect([path, await refusal(checkVisual(dir, cwd, path))]).toStrictEqual([path, "visual_outside"]);
    }
  });

  it("follows a link to the directory itself, as a home may be one", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(dir, "a.html"), "x");
    await symlink(dir, join(cwd, "linked"));

    expect((await checkVisual(join(cwd, "linked"), cwd, "linked/a.html")).size).toBe(1);
  });

  it("refuses the directory itself and its parent even when their names end in .html", async () => {
    const { cwd } = await place();
    const dir = join(cwd, "box.html", "lesson.html");
    await mkdir(dir, { recursive: true });

    expect(await refusal(checkVisual(dir, cwd, dir))).toBe("visual_outside");
    expect(await refusal(checkVisual(dir, cwd, join(dir, "..")))).toBe("visual_outside");
  });

  it("refuses a file it may not read with a code alone, never the file system's error and its path", async () => {
    const { cwd, dir } = await place();
    await mkdir(join(dir, "locked"));
    await writeFile(join(dir, "locked", "a.html"), "x");
    await writeFile(join(dir, "closed.html"), "x");
    await chmod(join(dir, "locked"), 0o000);
    await chmod(join(dir, "closed.html"), 0o000);
    onTestFinished(() => chmod(join(dir, "locked"), 0o755));

    const errors = await Promise.all(
      [
        checkVisual(dir, cwd, "visuals/locked/a.html"),
        checkVisual(dir, cwd, "visuals/closed.html"),
        readVisual(dir, join(dir, "closed.html")),
      ].map(async (call) =>
        call.then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );

    expect(errors.map((error) => [error instanceof CommandError, Reflect.get(Object(error), "code")])).toStrictEqual([
      [true, "visual_missing"],
      [true, "visual_missing"],
      [true, "visual_missing"],
    ]);
    expect(errors.map((error) => JSON.stringify(error) + String(error)).join("")).not.toContain(dir);
  });

  it("refuses a folder swapped for a link to the outside between the check and the opening", async () => {
    const { cwd, dir } = await place();
    await mkdir(join(dir, "lesson"));
    await writeFile(join(dir, "lesson", "a.html"), "inside");
    await mkdir(join(cwd, "secret"));
    await writeFile(join(cwd, "secret", "a.html"), "outside");
    const swap = swapOnce(join(dir, "lesson"), join(cwd, "secret"));

    expect(await refusal(checkVisual(dir, cwd, "visuals/lesson/a.html", swap))).toBe("visual_outside");
    expect(await refusal(readVisual(dir, join(dir, "lesson", "a.html"), swap))).toBe("visual_outside");
  });

  it("tells a missing file or directory", async () => {
    const { cwd, dir } = await place();

    expect(await refusal(checkVisual(dir, cwd, "visuals/none.html"))).toBe("visual_missing");
    expect(await refusal(checkVisual(dir, cwd, "visuals/sub/none.html"))).toBe("visual_missing");
    await writeFile(join(dir, "plain.html"), "x");
    expect(await refusal(checkVisual(dir, cwd, "visuals/plain.html/inside.html"))).toBe("visual_missing");
    await rm(dir, { recursive: true });
    expect(await refusal(checkVisual(dir, cwd, "visuals/none.html"))).toBe("visual_missing");
  });

  it("takes a file of 1 MB, and refuses one byte more", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(dir, "full.html"), "a".repeat(1024 * 1024));
    await writeFile(join(dir, "over.html"), "a".repeat(1024 * 1024 + 1));

    expect((await checkVisual(dir, cwd, "visuals/full.html")).size).toBe(1024 * 1024);
    expect(await refusal(checkVisual(dir, cwd, "visuals/over.html"))).toBe("visual_too_large");
  });
});

describe("readVisual", () => {
  it("reads the file as it is now, checked again", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(dir, "a.html"), "<p>one</p>");
    const { file } = await checkVisual(dir, cwd, "visuals/a.html");
    await writeFile(file, "<p>二</p>");

    expect(await readVisual(dir, file)).toBe("<p>二</p>");
  });

  it("refuses a file that became a link, grew too large or went away since it was checked", async () => {
    const { cwd, dir } = await place();
    await writeFile(join(cwd, "secret.html"), "x");
    await writeFile(join(dir, "a.html"), "x");
    const { file } = await checkVisual(dir, cwd, "visuals/a.html");

    await rm(file);
    expect(await refusal(readVisual(dir, file))).toBe("visual_missing");
    await symlink(join(cwd, "secret.html"), file);
    expect(await refusal(readVisual(dir, file))).toBe("visual_outside");
    await rm(file);
    await writeFile(file, "a".repeat(1024 * 1024 + 1));
    expect(await refusal(readVisual(dir, file))).toBe("visual_too_large");
  });
});

/**
 * A direction's directory with `visuals/` in it, and the place it was before it moved.
 *
 * @remarks
 * As archiving moves it under `Archive/`: the session's record keeps the old place.
 *
 * @sideEffects Creates the directories, removed when the test ends.
 * @returns The direction's directory now, its `visuals/`, and where it was.
 */
async function direction(): Promise<{ now: string; dir: string; was: string }> {
  const temp = await createTempDir("direction");
  onTestFinished(temp.cleanup);
  const root = await realpath(temp.path);
  const now = join(root, "Archive", "rust");
  await mkdir(join(now, "visuals"), { recursive: true });
  return { now, dir: join(now, "visuals"), was: join(root, "rust") };
}

describe("a direction's visuals (SPEC-0008, ML4)", () => {
  it("maps an absolute path under the recorded working directory onto where the direction is now", async () => {
    const { now, dir, was } = await direction();
    await writeFile(join(dir, "2-03-borrow.html"), "x");

    const relative = await checkVisual(dir, now, "visuals/2-03-borrow.html", undefined, { movedFrom: was });
    const old = await checkVisual(dir, now, join(was, "visuals", "2-03-borrow.html"), undefined, { movedFrom: was });

    expect(relative.file).toBe(join(dir, "2-03-borrow.html"));
    expect(old).toStrictEqual(relative);
    // An absolute path at where it is now stays as it is.
    expect(await checkVisual(dir, now, join(dir, "2-03-borrow.html"), undefined, { movedFrom: was })).toStrictEqual(
      relative,
    );
    expect(await refusal(checkVisual(dir, now, join(was, "visuals", "2-03-borrow.html")))).toBe("visual_outside");
    // Only the prefix is mapped; the checks run on what it maps to.
    expect(await refusal(checkVisual(dir, now, join(was, "secret.html"), undefined, { movedFrom: was }))).toBe(
      "visual_outside",
    );
    expect(
      await refusal(checkVisual(dir, now, `${was}-2/visuals/2-03-borrow.html`, undefined, { movedFrom: was })),
    ).toBe("visual_outside");
  });

  it("refuses a visuals folder that is a link, even to a folder inside the direction", async () => {
    const { now, dir } = await direction();
    await mkdir(join(now, "real"));
    await writeFile(join(now, "real", "a.html"), "x");
    await rm(dir, { recursive: true });
    await symlink(join(now, "real"), dir);
    const owned = { owned: async () => true };

    expect(await refusal(checkVisual(dir, now, "visuals/a.html", undefined, owned))).toBe("visual_outside");
    expect(await refusal(readVisual(dir, join(dir, "a.html"), undefined, owned.owned))).toBe("visual_outside");
    // Without the rule, as the home's own folders are, a link to the folder is followed.
    expect((await checkVisual(dir, now, "visuals/a.html")).size).toBe(1);
  });

  it.each(["check", "read"] as const)(
    "refuses visuals/ itself swapped for a link to the outside between the check and the opening (%s)",
    async (way) => {
      const { now, dir } = await direction();
      await writeFile(join(dir, "a.html"), "inside");
      await mkdir(join(now, "..", "..", "secret"));
      await writeFile(join(now, "..", "..", "secret", "a.html"), "outside");
      const swap = swapOnce(dir, join(now, "..", "..", "secret"));
      const owned = async () => (await lstat(now)).isDirectory();

      expect(await refusal(attempt(way, now, dir, swap, owned))).toBe("visual_outside");
    },
  );

  it.each(["check", "read"] as const)(
    "refuses the direction swapped for a link to a folder with the same visual, between the check and the opening (%s)",
    async (way) => {
      const { now, dir } = await direction();
      await writeFile(join(dir, "a.html"), "inside");
      const elsewhere = await sameVisualElsewhere(now);
      const swap = swapOnce(now, elsewhere);
      // As the host's check of a direction's place: a real folder, no link.
      const owned = async () => isRealFolder(now);

      expect(await refusal(attempt(way, now, dir, swap, owned))).toBe("visual_outside");
    },
  );

  it.each(["check", "read"] as const)(
    "refuses the direction swapped for a link right after its check and swapped back once the file is open (%s)",
    async (way) => {
      const { now, dir } = await direction();
      await writeFile(join(dir, "a.html"), "inside");
      const owned = swapThenBack(now, await sameVisualElsewhere(now));

      expect(await refusal(attempt(way, now, dir, undefined, owned))).toBe("visual_outside");
      expect(owned.calls()).toBe(2);
    },
  );

  it("refuses a visual when the direction's own place fails its check, and tells a missing folder as missing", async () => {
    const { now, dir } = await direction();
    await writeFile(join(dir, "a.html"), "x");

    expect(await refusal(checkVisual(dir, now, "visuals/a.html", undefined, { owned: async () => false }))).toBe(
      "visual_outside",
    );
    expect(await refusal(readVisual(dir, join(dir, "a.html"), undefined, async () => false))).toBe("visual_outside");
    await rm(dir, { recursive: true });
    expect(await refusal(checkVisual(dir, now, "visuals/a.html", undefined, { owned: async () => true }))).toBe(
      "visual_missing",
    );
    await writeFile(dir, "not a folder");
    expect(await refusal(checkVisual(dir, now, "visuals/a.html", undefined, { owned: async () => true }))).toBe(
      "visual_outside",
    );
  });
});

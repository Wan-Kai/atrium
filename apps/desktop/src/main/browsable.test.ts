import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBrowsable } from "./browsable";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atrium-browsable-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Writes a file, making its folders first.
 *
 * @remarks
 * The tests lay out workspaces and learning directions on disk.
 *
 * @sideEffects Creates folders and writes the file under the test's root.
 * @param path - Below the test's root.
 * @param text - What it holds.
 * @returns Its absolute path.
 */
async function put(path: string, text = "<p>x</p>"): Promise<string> {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
  return file;
}

describe("which files the page may open in the browser (security.md, Electron)", () => {
  it("opens a regular .html or .htm file, in a workspace's visuals/ too", async () => {
    expect(await isBrowsable(await put("project/index.html"))).toBe(true);
    expect(await isBrowsable(await put("project/A.HTM"))).toBe(true);
    expect(await isBrowsable(await put("project/visuals/a.html"))).toBe(true);
  });

  it("refuses a relative path, another kind of file, a folder, a link and a missing file", async () => {
    const page = await put("project/index.html");
    await put("project/notes.md");
    await mkdir(join(root, "project/dir.html"));
    await symlink(page, join(root, "project/link.html"));

    expect(await isBrowsable("project/index.html")).toBe(false);
    expect(await isBrowsable(join(root, "project/notes.md"))).toBe(false);
    expect(await isBrowsable(join(root, "project/dir.html"))).toBe(false);
    expect(await isBrowsable(join(root, "project/link.html"))).toBe(false);
    expect(await isBrowsable(join(root, "project/gone.html"))).toBe(false);
  });

  it("refuses anything in a learning direction's visuals/, at any depth and in any case, and opens lab/'s page", async () => {
    await put("Learning/rust/.atrium-study.json", "{}");
    await put("Learning/Archive/go/.atrium-study.json", "{}");

    expect(await isBrowsable(await put("Learning/rust/visuals/1-01-a.html"))).toBe(false);
    expect(await isBrowsable(await put("Learning/rust/Visuals/deep/a.HTML"))).toBe(false);
    expect(await isBrowsable(await put("Learning/Archive/go/VISUALS/a.htm"))).toBe(false);
    expect(await isBrowsable(await put("Learning/rust/lab/index.html"))).toBe(true);
    expect(await isBrowsable(await put("Learning/rust/lab/visuals/a.html"))).toBe(true);
  });
});

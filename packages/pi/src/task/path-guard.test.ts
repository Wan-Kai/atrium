import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { type PathGuardApi, checkWrite, guardPaths, outsideReason, realLocation, resolveWritten } from "./path-guard";

/** A directory tree in the system temp directory: a working directory, a sibling outside it, and a home. */
interface Tree {
  readonly cwd: string;
  readonly outside: string;
  readonly home: string;
}

/**
 * Makes a working directory with an outside directory and a home beside it, real paths all.
 *
 * @remarks
 * The tests write nothing, but their symbolic links must point at real directories; the root is
 * resolved so macOS's `/var` link does not hide a mistake.
 *
 * @sideEffects Creates temporary directories; deletes them when the test finishes.
 * @returns The three directories.
 */
async function tree(): Promise<Tree> {
  const dir = await createTempDir("path-guard");
  onTestFinished(dir.cleanup);
  const root = await realpathOf(dir.path);
  const made = { cwd: join(root, "work"), outside: join(root, "outside"), home: join(root, "home") };
  for (const path of Object.values(made)) await mkdir(path, { recursive: true });
  return made;
}

/**
 * The real path of a directory.
 *
 * @sideEffects Reads the file system.
 * @param path - The directory.
 * @returns Its real path.
 */
async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

describe("resolveWritten (step 1: pi's resolveToCwd)", () => {
  const cwd = "/w/proj";
  const home = "/h";

  it.each([
    ["a relative path is taken from the working directory", "a/b.txt", "/w/proj/a/b.txt"],
    ["dot segments are folded", "./a/../b.txt", "/w/proj/b.txt"],
    ["`..` climbs out of the working directory", "../outside.txt", "/w/outside.txt"],
    ["an absolute path stays", "/etc/x", "/etc/x"],
    ["a leading @ is dropped", "@a.txt", "/w/proj/a.txt"],
    ["a leading @ on an absolute path is dropped", "@/tmp/x", "/tmp/x"],
    ["only the first @ is dropped", "@@a.txt", "/w/proj/@a.txt"],
    ["an @ inside a name stays", "a@b.txt", "/w/proj/a@b.txt"],
    ["~ is the home directory", "~", "/h"],
    ["~/ is under the home directory", "~/x", "/h/x"],
    ["~ after @ is expanded, as pi strips @ first", "@~/x", "/h/x"],
    ["~name is not expanded", "~name/x", "/w/proj/~name/x"],
    ["file:// becomes a path", "file:///tmp/x", "/tmp/x"],
    ["file:// percent escapes are decoded", "file:///tmp/a%20b", "/tmp/a b"],
    ["a no-break space becomes a plain one", "a b.txt", "/w/proj/a b.txt"],
    ["a narrow no-break space becomes a plain one", "a b.txt", "/w/proj/a b.txt"],
    ["an ideographic space becomes a plain one", "a　b.txt", "/w/proj/a b.txt"],
    ["a space before the @ is no longer a leading @", " @a.txt", "/w/proj/ @a.txt"],
  ])("%s", (_name, input, expected) => {
    expect(resolveWritten(input, cwd, home)).toBe(expected);
  });
});

describe("realLocation (step 2)", () => {
  it("resolves an existing path through its links", async () => {
    const { cwd, outside } = await tree();
    await symlink(outside, join(cwd, "link"), "dir");

    expect(realLocation(join(cwd, "link"))).toBe(outside);
  });

  it("puts the missing rest back after the deepest existing ancestor", async () => {
    const { cwd, outside } = await tree();
    await symlink(outside, join(cwd, "link"), "dir");

    expect(realLocation(join(cwd, "link", "a", "b", "c.txt"))).toBe(join(outside, "a", "b", "c.txt"));
    expect(realLocation(join(cwd, "new", "deep", "c.txt"))).toBe(join(cwd, "new", "deep", "c.txt"));
  });

  it("takes a dangling link as what it points at, relative links from the link's directory", async () => {
    const { cwd, outside } = await tree();
    await symlink(join(outside, "gone.txt"), join(cwd, "dangling"));
    await mkdir(join(cwd, "sub"));
    await symlink("../ghost.txt", join(cwd, "sub", "rel"));

    expect(realLocation(join(cwd, "dangling"))).toBe(join(outside, "gone.txt"));
    expect(realLocation(join(cwd, "sub", "rel"))).toBe(join(cwd, "ghost.txt"));
  });

  it("gives up on a path it may not look into, instead of guessing from its parent", async () => {
    const { cwd } = await tree();
    const locked = join(cwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    onTestFinished(() => chmod(locked, 0o755));

    expect(realLocation(join(locked, "x.txt"))).toBeNull();
  });

  it("gives up on a link loop", async () => {
    const { cwd } = await tree();
    await symlink(join(cwd, "b"), join(cwd, "a"));
    await symlink(join(cwd, "a"), join(cwd, "b"));

    expect(realLocation(join(cwd, "a"))).toBeNull();
  });

  it("goes up past a file used as a directory", async () => {
    const { cwd } = await tree();
    await writeFile(join(cwd, "file.txt"), "x");

    expect(realLocation(join(cwd, "file.txt", "x"))).toBe(join(cwd, "file.txt", "x"));
  });
});

/** The verdict for a path, as the model might write it. */
const verdict = (input: string, t: Tree) => checkWrite(input, t.cwd, t.home);

describe("checkWrite (step 3)", () => {
  it.each([
    "ok.txt",
    "./ok.txt",
    "a/b/c/new.txt",
    "a/../ok.txt",
    ".github/workflows/ci.yml",
    ".gitignore",
    ".gitattributes",
    "@ok.txt",
    "a b.txt",
    "x/.git/y",
    "\u00A0/tmp/x",
  ])("lets %s through", async (input) => {
    const t = await tree();

    expect(verdict(input, t)).toStrictEqual({ allowed: true });
  });

  it("lets the working directory's own files through by absolute path, file:// URL and ~", async () => {
    const t = await tree();
    // `~` is the working directory's parent, so `~/work/x` lands inside.
    const home = { ...t, home: join(t.cwd, "..") };

    expect(verdict(join(t.cwd, "abs.txt"), t)).toStrictEqual({ allowed: true });
    expect(verdict(`file://${t.cwd}/url.txt`, t)).toStrictEqual({ allowed: true });
    expect(checkWrite("~/work/x.txt", home.cwd, home.home)).toStrictEqual({ allowed: true });
  });

  it.each([
    "../outside.txt",
    "a/../../outside.txt",
    "..",
    "../work-evil/x.txt",
    "@../outside.txt",
    "/etc/passwd",
    "@/tmp/x",
    "~/x",
    "~",
    "file:///tmp/x",
  ])("blocks %s with the one reason", async (input) => {
    const t = await tree();

    expect(verdict(input, t)).toStrictEqual({ allowed: false, reason: outsideReason(t.cwd) });
  });

  it("blocks a sibling whose name starts with the working directory's", async () => {
    const t = await tree();

    expect(verdict(`${t.cwd}-evil/x.txt`, t).allowed).toBe(false);
  });

  it("blocks a new file written through a directory link that points outside, however deep", async () => {
    const t = await tree();
    await symlink(t.outside, join(t.cwd, "link"), "dir");

    expect(verdict("link/new.txt", t).allowed).toBe(false);
    expect(verdict("link/a/b/new.txt", t).allowed).toBe(false);
  });

  it("blocks an existing file reached through a link, and a dangling link to the outside", async () => {
    const t = await tree();
    await writeFile(join(t.outside, "existing.txt"), "x");
    await symlink(join(t.outside, "existing.txt"), join(t.cwd, "file-link"));
    await symlink(join(t.outside, "gone.txt"), join(t.cwd, "dangling"));

    expect(verdict("file-link", t).allowed).toBe(false);
    expect(verdict("dangling", t).allowed).toBe(false);
  });

  it("lets through a link that points inside", async () => {
    const t = await tree();
    await mkdir(join(t.cwd, "real"));
    await symlink(join(t.cwd, "real"), join(t.cwd, "inner"), "dir");

    expect(verdict("inner/new.txt", t)).toStrictEqual({ allowed: true });
  });

  it("works when the working directory is itself a link", async () => {
    const t = await tree();
    const link = join(t.outside, "cwd-link");
    await symlink(t.cwd, link, "dir");

    expect(checkWrite("ok.txt", link, t.home)).toStrictEqual({ allowed: true });
    expect(checkWrite(join(link, "a.txt"), link, t.home)).toStrictEqual({ allowed: true });
    expect(checkWrite(join(t.cwd, "a.txt"), link, t.home)).toStrictEqual({ allowed: true });
    expect(checkWrite("../x.txt", link, t.home).allowed).toBe(false);
  });

  it.each([".git", ".git/config", "./.git/hooks/pre-commit", ".GIT/config", "a/../.git/config"])(
    "blocks %s, whether it is a directory or a worktree's pointer file",
    async (input) => {
      const t = await tree();
      await mkdir(join(t.cwd, ".git"));

      expect(verdict(input, t)).toStrictEqual({ allowed: false, reason: outsideReason(t.cwd) });
    },
  );

  it("blocks .git in any letter case, as the volumes macOS uses fold case", async () => {
    const t = await tree();

    expect(verdict(".GIT/config", t).allowed).toBe(false);
    expect(verdict(".Git", t).allowed).toBe(false);
  });

  it("blocks .git even when it does not exist yet, or is a file, or is reached through a link inside", async () => {
    const t = await tree();
    await writeFile(join(t.cwd, ".git"), "gitdir: /elsewhere\n");
    await symlink(join(t.cwd, ".git"), join(t.cwd, "alias"));

    expect(verdict(".git", t).allowed).toBe(false);
    expect(verdict("alias", t).allowed).toBe(false);
  });

  it("blocks when the target or the working directory cannot be worked out", async () => {
    const t = await tree();
    await symlink(join(t.cwd, "b"), join(t.cwd, "a"));
    await symlink(join(t.cwd, "a"), join(t.cwd, "b"));

    expect(verdict("a", t).allowed).toBe(false);
    expect(checkWrite("x.txt", join(t.cwd, "a"), t.home).allowed).toBe(false);
  });
});

describe("outsideReason", () => {
  it("tells the model where it may write", () => {
    expect(outsideReason("/w/proj")).toBe("Only files inside /w/proj can be changed.");
  });
});

describe("guardPaths", () => {
  type Handler = Parameters<PathGuardApi["on"]>[1];

  /**
   * Registers the guard on a stand-in and returns the hook it registered.
   *
   * @sideEffects none
   * @param on - Whether the session is isolated.
   * @returns The hook.
   */
  function hook(on: boolean): Handler {
    const handlers: Handler[] = [];
    guardPaths({ on: (_event, handler) => handlers.push(handler) }, () => on);
    const [only] = handlers;
    if (only === undefined || handlers.length !== 1) throw new Error("expected one hook");
    return only;
  }

  it("fits pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<PathGuardApi>();
    expect(true).toBe(true);
  });

  it("blocks edit and write outside the directory, with the reason, and lets the inside through", async () => {
    const t = await tree();
    const check = hook(true);

    for (const toolName of ["edit", "write"]) {
      expect(check({ toolName, input: { path: "../x.txt" } }, { cwd: t.cwd })).toStrictEqual({
        block: true,
        reason: outsideReason(t.cwd),
      });
      expect(check({ toolName, input: { path: "ok.txt" } }, { cwd: t.cwd })).toBeUndefined();
    }
  });

  it("leaves other tools, and calls without a text path, to pi", async () => {
    const t = await tree();
    const check = hook(true);

    expect(check({ toolName: "read", input: { path: "../x.txt" } }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "bash", input: { command: "cp a ../b" } }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "write", input: { path: 3 } }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "write", input: null }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "write", input: "../x" }, { cwd: t.cwd })).toBeUndefined();
  });

  it("lets everything through when the session is not isolated", async () => {
    const t = await tree();

    expect(hook(false)({ toolName: "write", input: { path: "../x.txt" } }, { cwd: t.cwd })).toBeUndefined();
  });
});

import { CommandError, type DirEntry } from "@atrium/protocol";
import { GIT_SCENE_ENV, createTempDir } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { GitError, type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { type WorkspaceFiles, createWorkspaceFiles } from "./workspace-files";

/** The workspace id the tests read. */
const WORKSPACE = "wks_0123456789abcdef";

/** The start of a PNG, enough to be recognized. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/**
 * A temporary directory removed after the test, outside any repository.
 *
 * @remarks
 * Its own subdirectory `w` is the workspace, so a link can point beside it.
 *
 * @sideEffects Creates the directories.
 * @returns The directory and its workspace.
 */
async function scene(): Promise<{ readonly root: string; readonly dir: string }> {
  const temp = await createTempDir("files");
  onTestFinished(temp.cleanup);
  const dir = join(temp.path, "w");
  await mkdir(dir);
  return { root: temp.path, dir };
}

/**
 * Makes the workspace a git repository.
 *
 * @remarks
 * With the scenes' environment, so no user configuration applies.
 *
 * @sideEffects Runs `git init`.
 * @param dir - The workspace.
 */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: dir, env: GIT_SCENE_ENV });
}

/**
 * The reader over one workspace, with a real git.
 *
 * @remarks
 * The log goes to memory, for the tests that check it.
 *
 * @sideEffects none
 * @param dir - The workspace.
 * @param git - git, if not the real one.
 * @returns The reader and the log.
 */
function filesOf(
  dir: string,
  git: GitRunner | null = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() }),
): { readonly files: WorkspaceFiles; readonly records: Record<string, unknown>[] } {
  const { logger, records } = recordingTracing();
  const files = createWorkspaceFiles({
    dirOf: (workspaceId) => (workspaceId === WORKSPACE ? dir : undefined),
    git: Promise.resolve(git),
    logger,
  });
  return { files, records };
}

/**
 * Entries in name order, for comparing; the answer itself is in no order.
 *
 * @remarks
 * By code point, as the tests name files.
 *
 * @sideEffects none
 * @param listed - The answer.
 * @returns The entries sorted, and whether it was cut.
 */
function sorted(listed: { entries: DirEntry[]; truncated: boolean }): { entries: DirEntry[]; truncated: boolean } {
  return { ...listed, entries: listed.entries.toSorted((a, b) => (a.name < b.name ? -1 : 1)) };
}

/**
 * The error code a promise rejects with.
 *
 * @remarks
 * Anything but a `CommandError` fails the test with what was thrown.
 *
 * @sideEffects none
 * @param promise - The call.
 * @returns The code.
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => new Error("resolved"),
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CommandError);
  return (error as CommandError).code;
}

describe("WorkspaceFiles.listDir", () => {
  it("lists files, directories and links, leaving out .git and what git ignores but not what it tracks", async () => {
    const { root, dir } = await scene();
    gitInit(dir);
    await writeFile(join(dir, ".gitignore"), "node_modules/\n*.log\nfoo\n");
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "a.log"), "");
    await writeFile(join(dir, "kept.log"), "");
    execFileSync("git", ["add", "-f", "kept.log"], { cwd: dir, env: GIT_SCENE_ENV });
    await writeFile(join(dir, ":(top)foo"), "");
    await writeFile(join(dir, ".env"), "");
    await symlink(join(root, "elsewhere"), join(dir, "latest"));
    const { files } = filesOf(dir);

    expect(sorted(await files.listDir(WORKSPACE, ""))).toStrictEqual({
      entries: [
        { name: ".env", kind: "file" },
        { name: ".gitignore", kind: "file" },
        { name: ":(top)foo", kind: "file" },
        { name: "kept.log", kind: "file" },
        { name: "latest", kind: "link" },
        { name: "src", kind: "dir" },
      ],
      truncated: false,
    });
  });

  it("asks git about a directory's own entries, by their place in it", async () => {
    const { dir } = await scene();
    gitInit(dir);
    await writeFile(join(dir, ".gitignore"), "/top.txt\nsrc/gen/\n");
    await mkdir(join(dir, "src", "gen"), { recursive: true });
    await writeFile(join(dir, "src", "top.txt"), "");
    await writeFile(join(dir, "src", "a.ts"), "");
    const { files } = filesOf(dir);

    expect(sorted(await files.listDir(WORKSPACE, "src"))).toStrictEqual({
      entries: [
        { name: "a.ts", kind: "file" },
        { name: "top.txt", kind: "file" },
      ],
      truncated: false,
    });
    expect(await files.listDir(WORKSPACE, "src/gen")).toStrictEqual({ entries: [], truncated: false });
  });

  it("leaves out only .git outside a repository, or without git", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, ".gitignore"), "*.log\n");
    await writeFile(join(dir, "a.log"), "");
    await mkdir(join(dir, ".git"));
    const expected = {
      entries: [
        { name: ".gitignore", kind: "file" },
        { name: "a.log", kind: "file" },
      ],
      truncated: false,
    };

    expect(sorted(await filesOf(dir).files.listDir(WORKSPACE, ""))).toStrictEqual(expected);
    expect(sorted(await filesOf(dir, null).files.listDir(WORKSPACE, ""))).toStrictEqual(expected);
  });

  it("leaves out what is neither a file, a directory nor a link, as a pipe", async () => {
    const { dir } = await scene();
    execFileSync("mkfifo", [join(dir, "pipe")]);
    await writeFile(join(dir, "a.ts"), "");

    expect(await filesOf(dir, null).files.listDir(WORKSPACE, "")).toStrictEqual({
      entries: [{ name: "a.ts", kind: "file" }],
      truncated: false,
    });
  });

  it("lists the first 5000 entries by name of a larger directory, saying it was cut", async () => {
    const { dir } = await scene();
    const names = Array.from({ length: 5001 }, (_, index) => `f${String(index).padStart(4, "0")}`);
    for (const name of names) await writeFile(join(dir, name), "");

    const listed = await filesOf(dir, null).files.listDir(WORKSPACE, "");

    expect(listed).toStrictEqual({
      entries: names.slice(0, 5000).map((name) => ({ name, kind: "file" })),
      truncated: true,
    });
  });

  it("lists a directory of exactly 5000 entries whole", async () => {
    const { dir } = await scene();
    for (let index = 0; index < 5000; index++) await writeFile(join(dir, `f${index}`), "");

    const listed = await filesOf(dir, null).files.listDir(WORKSPACE, "");

    expect([listed.entries.length, listed.truncated]).toStrictEqual([5000, false]);
  });

  it("refuses a path that is not plain, or that passes through or ends at a link, or is a file", async () => {
    const { root, dir } = await scene();
    await mkdir(join(root, "outside"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "a.ts"), "");
    await symlink(join(root, "outside"), join(dir, "out"));
    await symlink("src", join(dir, "inner"));
    const { files } = filesOf(dir, null);

    const paths = ["/", "/src", "src/", "./src", "src/.", "src/..", "..", "a//b", "src\0", "out", "inner", "a.ts"];
    expect(await Promise.all(paths.map((path) => codeOf(files.listDir(WORKSPACE, path))))).toStrictEqual(
      paths.map(() => "path_invalid"),
    );
  });

  it("says nothing is there for a missing path, one under a file, or a missing workspace directory", async () => {
    const { root, dir } = await scene();
    await writeFile(join(dir, "a.ts"), "");
    const { files } = filesOf(dir, null);
    const gone = filesOf(join(root, "gone"), null).files;

    expect([
      await codeOf(files.listDir(WORKSPACE, "nothing")),
      await codeOf(files.listDir(WORKSPACE, "nothing/below")),
      await codeOf(files.listDir(WORKSPACE, "a.ts/below")),
      await codeOf(gone.listDir(WORKSPACE, "")),
      await codeOf(files.listDir("wks_ffffffffffffffff", "")),
    ]).toStrictEqual(["path_not_found", "path_not_found", "path_not_found", "path_not_found", "workspace_not_found"]);
  });

  it("refuses a directory under a linked one, whatever the link points at", async () => {
    const { root, dir } = await scene();
    await mkdir(join(root, "outside", "deep"), { recursive: true });
    await symlink(join(root, "outside"), join(dir, "out"));

    expect(await codeOf(filesOf(dir, null).files.listDir(WORKSPACE, "out/deep"))).toBe("path_invalid");
  });

  it("reads a workspace reached through a link, as a project added by a linked path", async () => {
    const { root, dir } = await scene();
    await writeFile(join(dir, "a.ts"), "");
    await symlink(dir, join(root, "via"));

    expect(await filesOf(join(root, "via"), null).files.listDir(WORKSPACE, "")).toStrictEqual({
      entries: [{ name: "a.ts", kind: "file" }],
      truncated: false,
    });
  });

  it("fails as read_failed when git does, or a directory cannot be read, logging the workspace and the kind only", async () => {
    const { dir } = await scene();
    await mkdir(join(dir, "secret-dir"));
    await writeFile(join(dir, "a.ts"), "");
    const failing: GitRunner = { run: async () => ({ code: 129, stdout: "" }) };
    const throwing: GitRunner = {
      run: async () => {
        throw new GitError("check-ignore", "timeout");
      },
    };
    await chmod(join(dir, "secret-dir"), 0o000);
    onTestFinished(() => chmod(join(dir, "secret-dir"), 0o700));
    const failed = filesOf(dir, failing);
    const thrown = filesOf(dir, throwing);
    const locked = filesOf(dir, null);

    expect([
      await codeOf(failed.files.listDir(WORKSPACE, "")),
      await codeOf(thrown.files.listDir(WORKSPACE, "")),
      await codeOf(locked.files.listDir(WORKSPACE, "secret-dir")),
    ]).toStrictEqual(["read_failed", "read_failed", "read_failed"]);
    expect(
      [failed, thrown, locked].map(({ records }) =>
        records.map(({ msg, workspace_id, reason }) => ({ msg, workspace_id, reason })),
      ),
    ).toStrictEqual([
      [],
      [{ msg: "workspace file read failed", workspace_id: WORKSPACE, reason: "GitError" }],
      [{ msg: "workspace file read failed", workspace_id: WORKSPACE, reason: "EACCES" }],
    ]);
    expect(JSON.stringify(locked.records)).not.toContain("secret-dir");
  });
});

describe("WorkspaceFiles.readFile", () => {
  it("reads text, with its size in bytes", async () => {
    const { dir } = await scene();
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "const 名 = 1;\n");
    await writeFile(join(dir, "empty"), "");
    await writeFile(join(dir, "icon.svg"), "<svg/>");
    const { files } = filesOf(dir, null);

    expect([
      await files.readFile(WORKSPACE, "src/a.ts"),
      await files.readFile(WORKSPACE, "empty"),
      await files.readFile(WORKSPACE, "icon.svg"),
    ]).toStrictEqual([
      { size: 15, content: { kind: "text", text: "const 名 = 1;\n" } },
      { size: 0, content: { kind: "text", text: "" } },
      { size: 6, content: { kind: "text", text: "<svg/>" } },
    ]);
  });

  it("calls a file with a zero byte, or that is not UTF-8, binary", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, "zero"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(dir, "latin1"), Buffer.from("café au lait", "latin1"));
    await writeFile(join(dir, "late"), Buffer.concat([Buffer.alloc(20_000, 0x61), Buffer.from([0xc3])]));
    const { files } = filesOf(dir, null);

    expect([
      await files.readFile(WORKSPACE, "zero"),
      await files.readFile(WORKSPACE, "latin1"),
      await files.readFile(WORKSPACE, "late"),
    ]).toStrictEqual([
      { size: 3, content: { kind: "binary" } },
      { size: 12, content: { kind: "binary" } },
      { size: 20_001, content: { kind: "binary" } },
    ]);
  });

  it("does not read text over 1 MB, nor binary of any size", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, "at"), "a".repeat(1024 * 1024));
    await writeFile(join(dir, "over"), "a".repeat(1024 * 1024 + 1));
    await writeFile(join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
    const { files } = filesOf(dir, null);

    const at = await files.readFile(WORKSPACE, "at");
    expect([at.size, at.content.kind]).toStrictEqual([1024 * 1024, "text"]);
    expect([await files.readFile(WORKSPACE, "over"), await files.readFile(WORKSPACE, "big.bin")]).toStrictEqual([
      { size: 1024 * 1024 + 1, content: { kind: "too_large" } },
      { size: 2 * 1024 * 1024, content: { kind: "binary" } },
    ]);
  });

  it("knows the four images by their first bytes, whatever their names, as base64", async () => {
    const { dir } = await scene();
    const images = {
      "a.txt": [PNG, "image/png"],
      "b.png": [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), "image/jpeg"],
      c: [Buffer.from("GIF87a\x01\x00", "latin1"), "image/gif"],
      d: [Buffer.from("GIF89a\x01\x00", "latin1"), "image/gif"],
      e: [Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), "image/webp"],
    } as const;
    for (const [name, [bytes]] of Object.entries(images)) await writeFile(join(dir, name), bytes);
    const { files } = filesOf(dir, null);

    expect(await Promise.all(Object.keys(images).map((name) => files.readFile(WORKSPACE, name)))).toStrictEqual(
      Object.values(images).map(([bytes, mimeType]) => ({
        size: bytes.length,
        content: { kind: "image", mimeType, data: bytes.toString("base64") },
      })),
    );
  });

  it("does not take a name or a near miss for an image", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, "a.png"), "not a picture");
    await writeFile(join(dir, "riff"), "RIFF\x10\x00\x00\x00WAVEfmt ");
    await writeFile(join(dir, "gif"), "GIF88a");
    await writeFile(join(dir, "webp"), "RIFX\x10\x00\x00\x00WEBPVP8 ");
    const { files } = filesOf(dir, null);

    expect(
      await Promise.all(
        ["a.png", "riff", "gif", "webp"].map(async (name) => (await files.readFile(WORKSPACE, name)).content.kind),
      ),
    ).toStrictEqual(["text", "binary", "text", "binary"]);
  });

  it("reads an image up to 10 MB, not over", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, "at.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 - PNG.length)]));
    await writeFile(join(dir, "over.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1 - PNG.length)]));
    const { files } = filesOf(dir, null);

    const at = await files.readFile(WORKSPACE, "at.png");
    expect([at.size, at.content.kind]).toStrictEqual([10 * 1024 * 1024, "image"]);
    expect(await files.readFile(WORKSPACE, "over.png")).toStrictEqual({
      size: 10 * 1024 * 1024 + 1,
      content: { kind: "too_large" },
    });
  });

  it("reports a link as one, never reading what it points at", async () => {
    const { root, dir } = await scene();
    await writeFile(join(root, "secret"), "token");
    await symlink(join(root, "secret"), join(dir, "out"));
    await symlink("nowhere", join(dir, "dangling"));

    const { files } = filesOf(dir, null);

    expect([await files.readFile(WORKSPACE, "out"), await files.readFile(WORKSPACE, "dangling")]).toStrictEqual([
      { size: join(root, "secret").length, content: { kind: "link" } },
      { size: 7, content: { kind: "link" } },
    ]);
  });

  it("refuses a path that is not plain, passes through a link, or is not a file", async () => {
    const { root, dir } = await scene();
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret"), "token");
    await mkdir(join(dir, "src"));
    await symlink(join(root, "outside"), join(dir, "out"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    const { files } = filesOf(dir, null);

    const paths = ["", "/etc/hosts", "src/", "./src", "../outside/secret", "out/secret", "src", "pipe", "a\0"];
    expect(await Promise.all(paths.map((path) => codeOf(files.readFile(WORKSPACE, path))))).toStrictEqual(
      paths.map(() => "path_invalid"),
    );
  });

  it("refuses a socket, which does not open as a file", async () => {
    const { dir } = await scene();
    // Made under a short path, as a socket's may not pass 104 bytes, then moved in.
    const short = await mkdtemp("/tmp/atrium-socket-");
    onTestFinished(() => rm(short, { recursive: true, force: true }));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(short, "s"), resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await rename(join(short, "s"), join(dir, "s"));

    expect(await codeOf(filesOf(dir, null).files.readFile(WORKSPACE, "s"))).toBe("path_invalid");
  });

  it("says nothing is there for a missing file or workspace", async () => {
    const { dir } = await scene();
    const { files } = filesOf(dir, null);

    expect([
      await codeOf(files.readFile(WORKSPACE, "nothing.ts")),
      await codeOf(files.readFile(WORKSPACE, "src/nothing.ts")),
      await codeOf(files.readFile("wks_ffffffffffffffff", "a.ts")),
    ]).toStrictEqual(["path_not_found", "path_not_found", "workspace_not_found"]);
  });

  it("fails as read_failed when the file cannot be read, logging no path", async () => {
    const { dir } = await scene();
    await writeFile(join(dir, "secret.ts"), "token");
    await chmod(join(dir, "secret.ts"), 0o000);
    const { files, records } = filesOf(dir, null);

    expect(await codeOf(files.readFile(WORKSPACE, "secret.ts"))).toBe("read_failed");
    expect(records.map(({ msg, workspace_id, reason }) => ({ msg, workspace_id, reason }))).toStrictEqual([
      { msg: "workspace file read failed", workspace_id: WORKSPACE, reason: "EACCES" },
    ]);
    expect(JSON.stringify(records)).not.toContain("secret");
  });
});

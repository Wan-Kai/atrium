import { createTempDir } from "@atrium/testkit";
import { mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { discoverProjects } from "./discovery";

/**
 * A temporary directory, by its real path, removed after the test.
 *
 * @remarks
 * The real path, as the host reports discovered directories by theirs.
 *
 * @sideEffects Creates the directory.
 * @returns Its path.
 */
async function tempDir(): Promise<string> {
  const dir = await createTempDir("discovery");
  onTestFinished(dir.cleanup);
  return realpath(dir.path);
}

/**
 * Writes a session file of pi's for a working directory, last changed at `modifiedAt` seconds.
 *
 * @remarks
 * Only the header matters to discovery.
 *
 * @sideEffects Creates the folder and file.
 * @param sessions - pi's session directory.
 * @param name - The file name.
 * @param cwd - The working directory it names.
 * @param modifiedAt - When it last changed, in seconds since the epoch.
 */
async function session(sessions: string, name: string, cwd: string, modifiedAt: number): Promise<void> {
  const folder = join(sessions, `--${name}--`);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${name}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: "", cwd })}\n`);
  await utimes(path, modifiedAt, modifiedAt);
}

describe("discoverProjects", () => {
  it("offers the directories pi worked in, most recent first, leaving out what cannot become a project", async () => {
    const root = await tempDir();
    const sessions = join(root, "sessions");
    const dirs = ["old", "recent", "project", "project/src", "worktree", "chats/c1"];
    for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
    await symlink(join(root, "recent"), join(root, "link"));
    await session(sessions, "s1", join(root, "old"), 100);
    await session(sessions, "s2", join(root, "recent"), 200);
    await session(sessions, "s3", join(root, "link"), 300);
    await session(sessions, "s4", join(root, "project"), 400);
    await session(sessions, "s5", join(root, "project", "src"), 400);
    await session(sessions, "s6", join(root, "worktree"), 400);
    await session(sessions, "s7", join(root, "chats", "c1"), 400);
    await session(sessions, "s11", join(root, "chats"), 400);
    // Atrium may name its chats directory through a link; what is inside its real path is left out.
    await symlink(join(root, "chats"), join(root, "chats-link"));
    await session(sessions, "s8", join(root, "gone"), 400);
    await writeFile(join(root, "file"), "");
    await session(sessions, "s10", join(root, "file"), 400);
    // A sibling whose name starts like the chats directory's is not inside it.
    await mkdir(join(root, "chats-old"));
    await session(sessions, "s9", join(root, "chats-old"), 50);

    const found = await discoverProjects({
      location: { directory: sessions, perCwd: true },
      taken: [join(root, "project"), join(root, "worktree")],
      chatsRoot: join(root, "chats-link"),
    });

    // A folder inside a project can be added as a project of its own, so it stays.
    expect(found).toStrictEqual([
      { path: join(root, "project", "src"), sessions: 1, lastUsedAt: 400_000 },
      { path: join(root, "recent"), sessions: 2, lastUsedAt: 300_000 },
      { path: join(root, "old"), sessions: 1, lastUsedAt: 100_000 },
      { path: join(root, "chats-old"), sessions: 1, lastUsedAt: 50_000 },
    ]);
  });

  it("offers nothing before the tools are found, and stops when cancelled", async () => {
    const root = await tempDir();
    await mkdir(join(root, "work"));
    await session(join(root, "sessions"), "s1", join(root, "work"), 100);
    const reason = new Error("closing");

    expect(await discoverProjects({ location: null, taken: [], chatsRoot: join(root, "chats") })).toStrictEqual([]);
    await expect(
      discoverProjects({
        location: { directory: join(root, "sessions"), perCwd: true },
        taken: [],
        chatsRoot: join(root, "chats"),
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });
});

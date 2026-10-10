import { findFd } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { FakeClock, createTempDir, present } from "@atrium/testkit";
import { access, chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import { createFileSearch } from "./file-search";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A working directory with these files; a path ending in `/` is a directory.
 *
 * @remarks
 * Real files, searched by the real `fd` pi uses.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param entries - Paths and contents.
 * @returns The directory.
 */
async function workspace(entries: Readonly<Record<string, string>>): Promise<string> {
  const dir = await createTempDir("file-search");
  cleanups.push(dir.cleanup);
  const root = await realpath(dir.path);
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith("/")) {
      await mkdir(join(root, path), { recursive: true });
    } else {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
  return root;
}

/** The fd on this machine, as the host finds it. */
async function realFd(): Promise<string> {
  return present(await findFd({ HOME: homedir(), PATH: process.env["PATH"] ?? "" }), "fd, as pi installs it");
}

/** A search over the real fd, with the resources it counts. */
async function searcher(fd: string | null = null) {
  const resources = new ResourceTracker();
  const path = fd ?? (await realFd());
  return { search: createFileSearch({ findFd: async () => path, clock: systemClock, resources }), resources };
}

describe("createFileSearch against fd", () => {
  it("lists the directory's own entries first, hidden ones too, without .git or what .ignore names", async () => {
    const cwd = await workspace({
      "README.md": "",
      ".env.example": "",
      "src/a.ts": "",
      "src/deep/b.ts": "",
      ".git/": "",
      "build/out.js": "",
      ".ignore": "build/\n",
    });
    const { search, resources } = await searcher();

    const files = await search.search(cwd, "", new AbortController().signal);

    // With nothing typed every entry matches alike: shallower first, then shorter.
    expect(files.slice(0, 5).map((file) => file.path)).toStrictEqual([
      "src/",
      ".ignore",
      "README.md",
      ".env.example",
      "src/a.ts",
    ]);
    expect(files).toContainEqual({ path: "src/", directory: true });
    expect(files).toContainEqual({ path: "src/deep/b.ts", directory: false });
    expect(files.map((file) => file.path)).toStrictEqual(
      expect.not.arrayContaining([".git/", "build/", "build/out.js"]),
    );
    expect(resources.snapshot()["fd.process"]).toBe(0);
  });

  it("ranks matches as pi does, and finds names with characters patterns would choke on", async () => {
    const cwd = await workspace({
      "src/session.ts": "",
      "session-files.ts": "",
      "lib/sessions/x.ts": "",
      "a+b(1).ts": "",
    });
    const { search } = await searcher();

    const files = await search.search(cwd, "session", new AbortController().signal);
    const odd = await search.search(cwd, "+b(", new AbortController().signal);

    // fd matches names, not whole paths, unless the query has a slash: lib/sessions/x.ts is not found.
    expect(files.map((file) => file.path)).toStrictEqual(["lib/sessions/", "session-files.ts", "src/session.ts"]);
    expect(odd).toStrictEqual([{ path: "a+b(1).ts", directory: false }]);
  });

  it("searches inside a directory the query names, showing paths from the working directory", async () => {
    const cwd = await workspace({ "src/session.ts": "", "src/other.ts": "", "session.ts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "src/ses", new AbortController().signal)).toStrictEqual([
      { path: "src/session.ts", directory: false },
    ]);
  });

  it("finds nothing outside the working directory", async () => {
    const cwd = await workspace({ "a.ts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "../", new AbortController().signal)).toStrictEqual([]);
    expect(await search.search(cwd, "/etc/", new AbortController().signal)).toStrictEqual([]);
  });

  it("finds nothing for an absolute path, though the directory has one by that name inside", async () => {
    const cwd = await workspace({ "etc/hosts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "/etc/", new AbortController().signal)).toStrictEqual([]);
  });

  it("takes a query that looks like an fd option as text, never searching elsewhere", async () => {
    const outside = await workspace({ "secret.txt": "" });
    const cwd = await workspace({ "-notes.txt": "", "a.ts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, `--search-path=${outside}`, new AbortController().signal)).toStrictEqual([]);
    expect(await search.search(cwd, "-notes", new AbortController().signal)).toStrictEqual([
      { path: "-notes.txt", directory: false },
    ]);
  });

  it("finds nothing for a query fd cannot be given, holding no process", async () => {
    const cwd = await workspace({ "a.ts": "" });
    const { search, resources } = await searcher();

    expect(await search.search(cwd, "a\0b", new AbortController().signal)).toStrictEqual([]);
    expect(resources.snapshot()["fd.process"]).toBe(0);
  });

  it("answers fd_missing without fd", async () => {
    const cwd = await workspace({ "a.ts": "" });
    const search = createFileSearch({ findFd: async () => null, clock: systemClock, resources: new ResourceTracker() });

    await expect(search.search(cwd, "", new AbortController().signal)).rejects.toStrictEqual(
      new CommandError("fd_missing"),
    );
  });
});

/** An `fd` that never finishes, and the directory it is in. */
async function hangingFd(): Promise<string> {
  const dir = await workspace({ fd: "#!/bin/sh\nexec sleep 30\n" });
  await chmod(join(dir, "fd"), 0o755);
  return join(dir, "fd");
}

describe("createFileSearch stopping fd", () => {
  it("stops fd when the search is called off, finding nothing", async () => {
    const { search, resources } = await searcher(await hangingFd());
    const controller = new AbortController();

    const searching = search.search(await workspace({}), "x", controller.signal);
    await vi.waitFor(() => expect(resources.snapshot()["fd.process"]).toBe(1));
    controller.abort();

    expect(await searching).toStrictEqual([]);
    expect(resources.snapshot()["fd.process"]).toBe(0);
  });

  it("gives up after five seconds", async () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const fd = await hangingFd();
    const search = createFileSearch({ findFd: async () => fd, clock, resources });

    const searching = search.search(await workspace({}), "x", new AbortController().signal);
    await vi.waitFor(() => expect(resources.snapshot()["fd.process"]).toBe(1));
    clock.advance(4_999);
    expect(resources.snapshot()["fd.process"]).toBe(1);
    clock.advance(1);

    expect(await searching).toStrictEqual([]);
    expect(resources.snapshot()["fd.process"]).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });
});

/** An `fd` that runs `body` as a shell script. */
async function fakeFd(body: string): Promise<string> {
  const dir = await workspace({ fd: `#!/bin/sh\n${body}\n` });
  await chmod(join(dir, "fd"), 0o755);
  return join(dir, "fd");
}

describe("createFileSearch when fd misbehaves", () => {
  it("finds nothing when fd exits with an error, whatever it printed", async () => {
    const { search } = await searcher(await fakeFd("echo a.ts\nexit 2"));

    expect(await search.search(await workspace({}), "", new AbortController().signal)).toStrictEqual([]);
  });

  it("finds nothing when fd cannot start", async () => {
    const { search, resources } = await searcher("/nonexistent/fd");

    expect(await search.search(await workspace({}), "", new AbortController().signal)).toStrictEqual([]);
    expect(resources.snapshot()["fd.process"]).toBe(0);
  });

  it("finds nothing when fd prints more than a mebibyte", async () => {
    const { search } = await searcher(await fakeFd("yes a.ts | head -c 1100000"));

    expect(await search.search(await workspace({}), "", new AbortController().signal)).toStrictEqual([]);
  });

  it("pays no attention to what fd writes to its error stream", async () => {
    const { search } = await searcher(await fakeFd("head -c 2000000 /dev/zero >&2\necho a.ts"));

    expect(await search.search(await workspace({}), "", new AbortController().signal)).toStrictEqual([
      { path: "a.ts", directory: false },
    ]);
  });

  it("starts no fd when called off before", async () => {
    const { search, resources } = await searcher(await fakeFd("echo a.ts"));
    const controller = new AbortController();
    controller.abort();

    expect(await search.search(await workspace({}), "", controller.signal)).toStrictEqual([]);
    expect(resources.snapshot()["fd.process"]).toBeUndefined();
  });

  it("finds nothing when called off between its two runs, though the first found something", async () => {
    const marks = await workspace({});
    const mark = join(marks, "second-run");
    const fd = await fakeFd(
      `for a in "$@"; do if [ "$a" = "--max-depth" ]; then echo a.ts; exit 0; fi; done\ntouch '${mark}'\nexec sleep 30`,
    );
    const { search } = await searcher(fd);
    const controller = new AbortController();

    const searching = search.search(await workspace({}), "", controller.signal);
    await vi.waitFor(() => access(mark));
    controller.abort();

    expect(await searching).toStrictEqual([]);
  });
});

describe("createFileSearch's scope", () => {
  it("searches inside the directory a query names, finding what the whole path would not", async () => {
    const cwd = await workspace({ "src/session.ts": "", "src/sub/session.ts": "", "session.ts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "src/ses", new AbortController().signal)).toStrictEqual([
      { path: "src/session.ts", directory: false },
      { path: "src/sub/session.ts", directory: false },
    ]);
  });

  it("searches the whole path when the directory a query names does not exist", async () => {
    const cwd = await workspace({ "a/nope/x.ts": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "nope/x", new AbortController().signal)).toStrictEqual([
      { path: "a/nope/x.ts", directory: false },
    ]);
  });

  it("finds nothing for an absolute path, though a path below the directory has it", async () => {
    const cwd = await workspace({ "etc/x.conf": "" });
    const { search } = await searcher();

    expect(await search.search(cwd, "/etc/", new AbortController().signal)).toStrictEqual([]);
  });

  it("leaves no deadline behind once fd answers", async () => {
    const clock = new FakeClock();
    const fd = await realFd();
    const search = createFileSearch({ findFd: async () => fd, clock, resources: new ResourceTracker() });

    await search.search(await workspace({ "a.ts": "" }), "", new AbortController().signal);

    expect(clock.pendingTimers()).toBe(0);
  });
});

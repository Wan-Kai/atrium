import { acquirePiSettingsLock } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import filesystem, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPiConfig } from "./pi-config";

/** Creates isolated global and project directories.
 * @remarks Never opens the user's pi configuration.
 * @sideEffects Creates temporary files, removed after the test.
 */
async function fixture() {
  const temp = await createTempDir("pi-config");
  onTestFinished(temp.cleanup);
  const root = await realpath(temp.path);
  const global = join(root, "global");
  const project = join(root, "project");
  await mkdir(project);
  const service = createPiConfig({
    environment: async () => ({ HOME: root, PI_CODING_AGENT_DIR: global }),
    dirOf: (id) => (id === "wks_test" ? project : undefined),
  });
  return { service, root, global, project };
}

/** Runs a filesystem fault only at the intended path.
 * @remarks Fault selection is instrumentation, never a conditional test expectation.
 * @sideEffects Runs the supplied filesystem operation when the path matches.
 * @param actual - Path passed to the real filesystem method.
 * @param expected - Path selected for the fault.
 * @param action - Deterministic race or failure to inject.
 */
async function atPath(actual: unknown, expected: string, action: () => unknown): Promise<void> {
  if (actual === expected) await action();
}

/** Instruments real file opens at a deterministic boundary.
 * @remarks The real filesystem and handles are used; only scheduling of concurrent edits is controlled.
 * @sideEffects Wraps open until test cleanup and runs the supplied race after the real open.
 * @param matches - Which handle to instrument.
 * @param action - Filesystem edit or handle observation after opening.
 */
function afterOpen(
  matches: (path: unknown) => boolean,
  action: (handle: FileHandle, path: unknown) => Promise<void>,
): void {
  const original = filesystem.open;
  const spy = vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (matches(args[0])) await action(handle, args[0]);
    return handle;
  });
  syncBuiltinESMExports();
  onTestFinished(() => {
    spy.mockRestore();
    syncBuiltinESMExports();
  });
}

/** Observes the final read closing after the temporary write rather than counting metadata calls.
 * @remarks The next parent metadata check is the commit boundary regardless of earlier lock or path checks.
 * @sideEffects Instruments real file-handle closes until test cleanup.
 * @param path - Saved target path.
 * @param phase - Metadata boundary selected for fault injection.
 */
function commitPhase(
  path: string,
  phase: "read-parent" | "read-target" | "save-parent" = "save-parent",
): () => boolean {
  let temporaryClosed = false;
  let finalReadClosed = false;
  let targetOpened = false;
  afterOpen(
    (opened) => opened === path || String(opened).startsWith(join(dirname(path), ".atrium-config-")),
    async (handle, opened) => {
      if (opened === path) targetOpened = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        if (opened === path && temporaryClosed) finalReadClosed = true;
        if (opened !== path) temporaryClosed = true;
      });
    },
  );
  return () => {
    const active = phase === "read-target" || (phase === "read-parent" ? targetOpened : finalReadClosed);
    targetOpened = false;
    finalReadClosed = false;
    return active;
  };
}

/** Schedules one filesystem race once without counting unrelated metadata calls.
 * @remarks Scope rechecks may revisit the same path after a failed operation.
 * @sideEffects Runs the supplied filesystem edit once.
 * @param action - The concurrent edit to schedule.
 */
function once(action: () => Promise<void>): () => Promise<void> {
  let ran = false;
  return async () => {
    if (!ran) {
      ran = true;
      await action();
    }
  };
}

describe("ordinary pi configuration files", () => {
  it("reads missing files without creating them and saves exact text with a revision and private permissions", async () => {
    const { service, global } = await fixture();
    expect(await service.read(null, "settings.json")).toStrictEqual({
      path: join(global, "settings.json"),
      text: "{}\n",
      revision: null,
    });
    await expect(stat(global)).rejects.toMatchObject({ code: "ENOENT" });
    const text = '{\n "theme": "dark"\n}\n';
    const saved = await service.save(null, "settings.json", text, null);
    expect(saved).toStrictEqual({
      path: join(global, "settings.json"),
      text,
      revision: createHash("sha256").update(text).digest("hex"),
    });
    expect(await service.read(null, "settings.json")).toStrictEqual(saved);
    expect(await readFile(saved.path, "utf8")).toBe(text);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "config_conflict" });
    expect((await service.save(null, "settings.json", "{}", saved.revision)).text).toBe("{}");
    await writeFile(saved.path, '{"external":true}');
    await expect(service.save(null, "settings.json", "{}", saved.revision)).rejects.toMatchObject({
      code: "config_conflict",
    });
    expect(await readFile(saved.path, "utf8")).toBe('{"external":true}');
  });

  it("preserves pi-compatible model comments, trailing commas, BOM and empty settings", async () => {
    const { service } = await fixture();
    const models = '\uFEFF{\n// models\n"providers": {},\n}\n';
    expect((await service.save(null, "models.json", models, null)).text).toBe(models);
    expect((await service.read(null, "models.json")).text).toBe(models);
    for (const text of [" ", "\uFEFF", "\uFEFF  \n"]) {
      await expect(service.save(null, "settings.json", text, null)).rejects.toMatchObject({ code: "config_invalid" });
    }
    expect((await service.save(null, "settings.json", "", null)).text).toBe("");
  });

  it("never recreates a missing project root for read or initial save", async () => {
    const { service, project } = await fixture();
    await filesystem.rmdir(project);
    await expect(service.read("wks_test", "settings.json")).rejects.toMatchObject({ code: "workspace_not_found" });
    await expect(service.save("wks_test", "settings.json", "{}", null)).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    await expect(stat(project)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a project disappearing during read or save without recreating it", async () => {
    const { service, project } = await fixture();
    const saved = await service.save("wks_test", "settings.json", "{}", null);
    afterOpen(
      (opened) => opened === saved.path,
      async () => {
        await filesystem.rename(project, `${project}.gone`);
      },
    );
    await expect(service.read("wks_test", "settings.json")).rejects.toMatchObject({ code: "workspace_not_found" });
    await expect(stat(project)).rejects.toMatchObject({ code: "ENOENT" });
    await filesystem.rename(`${project}.gone`, project);
    await expect(service.save("wks_test", "settings.json", '{"edited":true}', saved.revision)).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    await expect(stat(project)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate a workspace disappearing just before .pi creation", async () => {
    const { service, project } = await fixture();
    const original = filesystem.mkdir;
    const spy = vi.spyOn(filesystem, "mkdir").mockImplementation(async (...args) => {
      await atPath(args[0], join(project, ".pi"), () => filesystem.rename(project, `${project}.gone`));
      return original(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.save("wks_test", "settings.json", "{}", null)).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    await expect(stat(project)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(`${project}.gone`)).toStrictEqual([]);
  });

  it("validates JSON objects and limits UTF8 bytes before writing", async () => {
    const { service } = await fixture();
    for (const text of ["{", "[]", "null", "1", '"secret"']) {
      await expect(service.save(null, "models.json", text, null)).rejects.toMatchObject({ code: "config_invalid" });
    }
    await expect(
      service.save(null, "settings.json", JSON.stringify({ x: "界".repeat(100_000) }), null),
    ).rejects.toMatchObject({ code: "config_too_large" });
  });

  it("holds pi's settings lock across the write and releases it after success, conflict and failure", async () => {
    const { service, global } = await fixture();
    const initial = await service.save(null, "settings.json", "{}", null);
    const external = await acquirePiSettingsLock(initial.path);
    try {
      await expect(service.save(null, "settings.json", '{"x":1}', initial.revision)).rejects.toMatchObject({
        code: "config_conflict",
      });
    } finally {
      await external.release();
    }
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async () => {
        await expect(acquirePiSettingsLock(initial.path)).rejects.toMatchObject({ code: "ELOCKED" });
        await writeFile(initial.path, '{"external":true}');
      },
    );
    await expect(service.save(null, "settings.json", '{"x":1}', initial.revision)).rejects.toMatchObject({
      code: "config_conflict",
    });
    expect(await readdir(global)).toStrictEqual(["settings.json"]);
    const reacquired = await acquirePiSettingsLock(initial.path);
    await reacquired.release();
  });

  it("serializes simultaneous saves so exactly one stale revision succeeds", async () => {
    const { service } = await fixture();
    const outcomes = await Promise.allSettled([
      service.save(null, "mcp.json", '{"a":1}', null),
      service.save(null, "mcp.json", '{"a":2}', null),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toStrictEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "config_conflict" }) }),
    ]);
  });

  it("isolates project and custom global configuration and runtime-rejects credentials and paths", async () => {
    const { service, project, global } = await fixture();
    await service.save(null, "settings.json", '{"global":true}', null);
    expect(await service.save("wks_test", "settings.json", "{}", null)).toMatchObject({
      path: join(project, ".pi", "settings.json"),
    });
    expect(await readFile(join(global, "settings.json"), "utf8")).toBe('{"global":true}');
    for (const name of ["auth.json", "mcp-auth.json", "../auth.json", "/tmp/auth.json", "unknown.json"]) {
      // Runtime input must be checked even when TypeScript callers cannot supply it.
      await expect(service.read(null, name as "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
      await expect(service.save(null, name as "settings.json", "{}", null)).rejects.toMatchObject({
        code: "path_invalid",
      });
    }
    for (const name of ["models.json", "keybindings.json"] as const)
      await expect(service.read("wks_test", name)).rejects.toMatchObject({ code: "path_invalid" });
    await expect(service.read("missing", "settings.json")).rejects.toMatchObject({ code: "workspace_not_found" });
  });

  it("rejects oversized existing files, nonregular files, symlinks and hardlinked credential aliases", async () => {
    const { service, root, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "x".repeat(256 * 1024 + 1));
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "config_too_large" });
    const credential = join(root, "auth.json");
    await writeFile(credential, '{"secret":true}');
    await symlink(credential, join(global, "models.json"));
    await link(credential, join(global, "mcp.json"));
    await mkdir(join(global, "keybindings.json"));
    for (const name of ["models.json", "mcp.json", "keybindings.json"] as const) {
      await expect(service.read(null, name)).rejects.toMatchObject({ code: "path_invalid" });
      await expect(service.save(null, name, "{}", null)).rejects.toMatchObject({ code: "path_invalid" });
    }
    expect(await readFile(credential, "utf8")).toBe('{"secret":true}');
  });

  it("does not block on FIFOs and preserves malformed existing text for repair", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    execFileSync("/usr/bin/mkfifo", [join(global, "settings.json")]);
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "path_invalid" });
    await writeFile(join(global, "models.json"), "{broken");
    const broken = await service.read(null, "models.json");
    expect(broken.text).toBe("{broken");
    expect(await service.save(null, "models.json", "{}\n", broken.revision)).toMatchObject({ text: "{}\n" });
  });

  it("rejects invalid UTF8 bytes without replacing their contents on save", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    await writeFile(path, bytes);
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "config_encoding" });
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "config_encoding" });
    expect(await readFile(path)).toStrictEqual(bytes);
  });

  it("uses pi's HOME default and tilde expansion and accepts the exact byte boundary", async () => {
    const { root } = await fixture();
    for (const [env, dir] of [
      [{ HOME: root }, join(root, ".pi", "agent")],
      [{ HOME: root, PI_CODING_AGENT_DIR: "" }, join(root, ".pi", "agent")],
      [{ HOME: root, PI_CODING_AGENT_DIR: "~/custom" }, join(root, "custom")],
      [{ HOME: root, PI_CODING_AGENT_DIR: "~" }, root],
    ] as const) {
      const service = createPiConfig({
        environment: async () => env,
        dirOf: () => undefined,
      });
      const text = JSON.stringify({ x: "a".repeat(256 * 1024 - 8) });
      expect(Buffer.byteLength(text)).toBe(256 * 1024);
      const before = await service.read(null, "keybindings.json");
      const result = await service.save(null, "keybindings.json", text, before.revision);
      expect(result.path).toBe(join(dir, "keybindings.json"));
      expect(await service.read(null, "keybindings.json")).toStrictEqual(result);
    }
  });

  it("maps OS read/write failures without leaking paths and removes temporary files", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    await chmod(path, 0o000);
    onTestFinished(() => chmod(path, 0o600));
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "read_failed" });
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "read_failed" });
    await chmod(path, 0o600);
    const before = await service.read(null, "settings.json");
    await chmod(global, 0o500);
    onTestFinished(() => chmod(global, 0o700));
    await expect(service.save(null, "settings.json", '{"edit":true}', before.revision)).rejects.toMatchObject({
      code: "read_failed",
    });
    await chmod(global, 0o700);
    expect(await readdir(global)).toStrictEqual(["settings.json"]);
    const reacquired = await acquirePiSettingsLock(path);
    await reacquired.release();
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("reads missing files in an existing directory, project mcp, BOM text, and private new directories", async () => {
    const { service, global, project } = await fixture();
    await mkdir(global);
    expect(await service.read(null, "settings.json")).toStrictEqual({
      path: join(global, "settings.json"),
      text: "{}\n",
      revision: null,
    });
    await writeFile(join(global, "models.json"), "\uFEFF{}\n");
    expect((await service.read(null, "models.json")).text).toBe("\uFEFF{}\n");
    expect(await service.save("wks_test", "mcp.json", "{}", null)).toMatchObject({
      path: join(project, ".pi", "mcp.json"),
    });
    expect((await stat(join(project, ".pi"))).mode & 0o777).toBe(0o700);
    const relative = createPiConfig({
      environment: async () => ({ PI_CODING_AGENT_DIR: "relative" }),
      dirOf: () => undefined,
    });
    await expect(relative.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(relative.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "path_invalid" });
    const blocked = createPiConfig({
      environment: async () => ({ PI_CODING_AGENT_DIR: join(global, "models.json", "nested") }),
      dirOf: () => undefined,
    });
    await expect(blocked.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
  });

  it("detects target replacement after opening and closes the original handle", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    const closed: ReturnType<typeof vi.spyOn>[] = [];
    afterOpen(
      (opened) => opened === path,
      async (handle) => {
        closed.push(vi.spyOn(handle, "close"));
        await filesystem.rename(path, `${path}.old`);
        await writeFile(path, "{}");
      },
    );
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveBeenCalledOnce();
  });

  it("detects parent replacement while a file is open", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    afterOpen(
      (opened) => opened === path,
      async () => {
        await filesystem.rename(global, `${global}.old`);
        await mkdir(global);
        await filesystem.rename(join(`${global}.old`, "settings.json"), path);
      },
    );
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
  });

  it("rechecks the revision after writing the temporary file and removes it on conflict", async () => {
    const { service, global } = await fixture();
    const first = await service.save(null, "settings.json", "{}", null);
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async () => {
        await writeFile(first.path, '{"external":true}');
      },
    );
    await expect(service.save(null, "settings.json", '{"edited":true}', first.revision)).rejects.toMatchObject({
      code: "config_conflict",
    });
    expect(await readFile(first.path, "utf8")).toBe('{"external":true}');
    expect(await readdir(global)).toStrictEqual(["settings.json"]);
  });

  it("fails directory metadata access instead of treating denied paths as missing", async () => {
    const { root } = await fixture();
    const denied = join(root, "denied");
    await mkdir(denied, { mode: 0o000 });
    onTestFinished(() => chmod(denied, 0o700));
    const service = createPiConfig({
      environment: async () => ({ PI_CODING_AGENT_DIR: join(denied, "nested") }),
      dirOf: () => undefined,
    });
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "read_failed" });
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "read_failed" });
  });

  it("handles another creator winning directory creation without following a link", async () => {
    const { service, global } = await fixture();
    const original = filesystem.mkdir;
    const spy = vi.spyOn(filesystem, "mkdir").mockImplementation(async (...args) => {
      const result = await original(...args);
      await atPath(args[0], global, () => {
        throw Object.assign(new Error("another creator"), { code: "EEXIST" });
      });
      return result;
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    expect(await service.save(null, "settings.json", "{}", null)).toMatchObject({ text: "{}" });
  });

  it("limits reads when a file grows after its initial stat", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    afterOpen(
      (opened) => opened === path,
      async (handle) => {
        const originalStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          const info = await originalStat(...statArgs);
          await writeFile(path, "x".repeat(256 * 1024 + 1));
          return info;
        });
      },
    );
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "config_too_large" });
  });

  it("rejects hard links created during a read", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    const original = filesystem.lstat;
    const spy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      await atPath(args[0], path, () => link(path, `${path}.alias`));
      return original(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
  });

  it("closes a saved temporary handle without unlinking after successful rename", async () => {
    const { service, global } = await fixture();
    const closed: ReturnType<typeof vi.spyOn>[] = [];
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async (handle) => {
        closed.push(vi.spyOn(handle, "close"));
      },
    );
    const unlinkSpy = vi
      .spyOn(filesystem, "unlink")
      .mockRejectedValue(Object.assign(new Error("cleanup failed"), { code: "EACCES" }));
    syncBuiltinESMExports();
    onTestFinished(() => {
      unlinkSpy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.save(null, "settings.json", "{}", null)).resolves.toMatchObject({ text: "{}" });
    expect(await readFile(join(global, "settings.json"), "utf8")).toBe("{}");
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveBeenCalledOnce();
  });

  it("queues several same-path saves in order while unrelated paths remain writable", async () => {
    const { service } = await fixture();
    const initial = await service.save(null, "settings.json", "{}", null);
    const commands = new AsyncLocalStorage<string>();
    const firstBlocked = Promise.withResolvers<void>();
    const secondBlocked = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    onTestFinished(() => {
      releaseFirst.resolve();
      releaseSecond.resolve();
    });
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async () => {
        await atPath(commands.getStore(), "first", async () => {
          firstBlocked.resolve();
          await releaseFirst.promise;
        });
        await atPath(commands.getStore(), "second", async () => {
          secondBlocked.resolve();
          await releaseSecond.promise;
        });
      },
    );
    const metadata = filesystem.lstat;
    const reads: string[] = [];
    const spy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      await atPath(args[0], initial.path, () => {
        reads.push(String(commands.getStore()));
      });
      return metadata(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    const texts = ['{"order":1}', '{"order":2}', '{"order":3}', '{"order":4}'] as const;
    const [one, two, three, four] = texts;
    const first = commands.run("first", () =>
      service.save(null, "settings.json", one, initial.revision).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    await firstBlocked.promise;
    const second = commands.run("second", () =>
      service.save(null, "settings.json", two, createHash("sha256").update(one).digest("hex")).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    const third = commands.run("third", () =>
      service.save(null, "settings.json", three, createHash("sha256").update(two).digest("hex")).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    await commands.run("other", () => service.save(null, "mcp.json", "{}", null));
    expect(reads).not.toContain("second");
    expect(reads).not.toContain("third");
    releaseFirst.resolve();
    expect(await first).toMatchObject({ value: { text: one } });
    await secondBlocked.promise;
    const fourth = commands.run("fourth", () =>
      service.save(null, "settings.json", four, createHash("sha256").update(three).digest("hex")).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    // A real unrelated-path save supplies a positive liveness barrier while the second save is held.
    const other = await service.read(null, "mcp.json");
    await commands.run("other", () => service.save(null, "mcp.json", '{"other":true}', other.revision));
    expect(reads).not.toContain("fourth");
    releaseSecond.resolve();
    expect(await second).toMatchObject({ value: { text: two } });
    expect(await third).toMatchObject({ value: { text: three } });
    expect(await fourth).toMatchObject({ value: { text: four } });
  });

  it("handles filesystem-root configuration using actual root metadata without opening real root configs", async () => {
    const { root } = await fixture();
    const safeFile = join(root, "safe-settings.json");
    await writeFile(safeFile, '{"isolated":true}');
    const realOpen = filesystem.open;
    const realStat = filesystem.lstat;
    const openSpy = vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      await atPath(args[0], "/settings.json", () => {
        args[0] = safeFile;
      });
      return realOpen(...args);
    });
    const statSpy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      await atPath(args[0], "/settings.json", () => {
        args[0] = safeFile;
      });
      return realStat(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      openSpy.mockRestore();
      statSpy.mockRestore();
      syncBuiltinESMExports();
    });
    const service = createPiConfig({ environment: async () => ({ PI_CODING_AGENT_DIR: "/" }), dirOf: () => undefined });
    expect(await service.read(null, "settings.json")).toMatchObject({
      path: "/settings.json",
      text: '{"isolated":true}',
    });
  });

  it("does not open a target when its parent is missing", async () => {
    const { service } = await fixture();
    const spy = vi.spyOn(filesystem, "open");
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    expect((await service.read(null, "settings.json")).revision).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["hardlink", "oversized"] as const)("rejects %s files before reading any bytes", async (kind) => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    const setups = {
      hardlink: async () => {
        await writeFile(path, "{}");
        await link(path, `${path}.alias`);
      },
      oversized: async () => {
        await writeFile(path, "x".repeat(256 * 1024 + 1));
      },
    };
    await setups[kind]();
    const reads: ReturnType<typeof vi.spyOn>[] = [];
    afterOpen(
      (opened) => opened === path,
      async (handle) => {
        reads.push(vi.spyOn(handle, "read"));
      },
    );
    const codes = { hardlink: "path_invalid", oversized: "config_too_large" };
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: codes[kind] });
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toHaveBeenCalled();
  });

  it("rejects final save-directory replacement and preserves the externally moved file", async () => {
    const { service, global } = await fixture();
    const initial = await service.save(null, "settings.json", "{}", null);
    const original = filesystem.lstat;
    const committing = commitPhase(initial.path);
    const replacement = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      await atPath(args[0], global, async () => {
        await atPath(String(committing()), "true", async () => {
          await filesystem.rename(global, `${global}.moved`);
          await mkdir(global);
          await filesystem.rename(join(`${global}.moved`, "settings.json"), initial.path);
        });
      });
      return original(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      replacement.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.save(null, "settings.json", '{"edit":true}', initial.revision)).rejects.toMatchObject({
      code: "path_invalid",
    });
    expect(await readFile(initial.path, "utf8")).toBe("{}");
    expect(await readdir(global)).toStrictEqual(["settings.json"]);
  });

  it.each(["read-parent", "read-target", "save-parent"] as const)(
    "detects %s cross-device identity changes with an unchanged inode",
    async (phase) => {
      const { service, global } = await fixture();
      const initial = await service.save(null, "settings.json", "{}", null);
      const targets = { "read-parent": global, "read-target": initial.path, "save-parent": global };
      const active = commitPhase(initial.path, phase);
      const original = filesystem.lstat;
      const spy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
        const info = await original(...args);
        await atPath(args[0], targets[phase], async () => {
          await atPath(String(active()), "true", () => {
            // Mount replacement with a coincident inode cannot be arranged portably without privileges.
            // Inject only that metadata change; every actual file operation still uses the real filesystem.
            Reflect.set(info, "dev", Number(info.dev) + 1);
          });
        });
        return info;
      });
      syncBuiltinESMExports();
      onTestFinished(() => {
        spy.mockRestore();
        syncBuiltinESMExports();
      });
      const operations = {
        "read-parent": () => service.read(null, "settings.json"),
        "read-target": () => service.read(null, "settings.json"),
        "save-parent": () => service.save(null, "settings.json", '{"edit":true}', initial.revision),
      };
      await expect(operations[phase]()).rejects.toMatchObject({ code: "path_invalid" });
    },
  );

  it("does not recreate a parent removed while reading", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const path = join(global, "settings.json");
    await writeFile(path, "{}");
    afterOpen(
      (opened) => opened === path,
      async () => {
        await filesystem.rename(global, `${global}.removed`);
      },
    );
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(stat(global)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate a parent removed immediately before commit", async () => {
    const { service, global } = await fixture();
    const initial = await service.save(null, "settings.json", "{}", null);
    const original = filesystem.lstat;
    const committing = commitPhase(initial.path);
    const spy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      await atPath(args[0], global, async () => {
        await atPath(String(committing()), "true", () => filesystem.rename(global, `${global}.removed`));
      });
      return original(...args);
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.save(null, "settings.json", '{"edit":true}', initial.revision)).rejects.toMatchObject({
      code: "path_invalid",
    });
    await expect(stat(global)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale revision before creating any temporary file", async () => {
    const { service } = await fixture();
    await service.save(null, "settings.json", "{}", null);
    const temporaryOpens: string[] = [];
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async (handle) => {
        temporaryOpens.push(String(handle.fd));
      },
    );
    await expect(service.save(null, "settings.json", '{"edit":true}', null)).rejects.toMatchObject({
      code: "config_conflict",
    });
    expect(temporaryOpens).toStrictEqual([]);
  });

  it("does not swallow directory creation errors even if another actor creates it", async () => {
    const { service, global } = await fixture();
    const original = filesystem.mkdir;
    const spy = vi.spyOn(filesystem, "mkdir").mockImplementation(async (...args) => {
      const result = await original(...args);
      await atPath(args[0], global, () => {
        throw Object.assign(new Error("denied while another actor creates"), { code: "EACCES" });
      });
      return result;
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.save(null, "settings.json", "{}", null)).rejects.toMatchObject({ code: "read_failed" });
  });

  it.each(["EMLINK", "ENXIO", "ENODEV"])("maps platform no-follow/nonregular open errno %s", async (code) => {
    const { service, global } = await fixture();
    await mkdir(global);
    const spy = vi
      .spyOn(filesystem, "open")
      .mockRejectedValue(Object.assign(new Error("platform open failure"), { code }));
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.read(null, "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
  });

  it("rejects project .pi aliases while allowing trusted global aliases", async () => {
    const { service, global, project } = await fixture();
    await mkdir(global);
    await writeFile(join(global, "settings.json"), '{"private":true}');
    await symlink(global, join(project, ".pi"));
    await expect(service.read("wks_test", "settings.json")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(service.save("wks_test", "settings.json", "{}", null)).rejects.toMatchObject({ code: "path_invalid" });
    expect(await readFile(join(global, "settings.json"), "utf8")).toBe('{"private":true}');
  });

  it("pins the existing global ancestor and never recreates it when missing descendants are saved", async () => {
    const { service, root, global } = await fixture();
    const original = filesystem.lstat;
    const remove = once(() => filesystem.rename(root, `${root}.gone`));
    const spy = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (error) {
        await atPath(args[0], global, remove);
        throw error;
      }
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    try {
      await expect(service.save(null, "mcp.json", "{}", null)).rejects.toMatchObject({ code: "path_invalid" });
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(`${root}.gone`)).toStrictEqual(["project"]);
    } finally {
      await filesystem.rename(`${root}.gone`, root);
    }
  });

  it("rejects replacement of an existing global directory even when the selected file is absent", async () => {
    const { service, global } = await fixture();
    await mkdir(global);
    const original = filesystem.open;
    const spy = vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (error) {
        await atPath(args[0], join(global, "mcp.json"), async () => {
          await filesystem.rename(global, `${global}.old`);
          await mkdir(global);
        });
        throw error;
      }
    });
    syncBuiltinESMExports();
    onTestFinished(() => {
      spy.mockRestore();
      syncBuiltinESMExports();
    });
    await expect(service.read(null, "mcp.json")).rejects.toMatchObject({ code: "path_invalid" });
    expect(await readdir(global)).toStrictEqual([]);
  });

  it("rejects a global agent-directory alias retargeted during save", async () => {
    const { root } = await fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "alias");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    const service = createPiConfig({
      environment: async () => ({ PI_CODING_AGENT_DIR: alias }),
      dirOf: () => undefined,
    });
    const initial = await service.save(null, "settings.json", "{}", null);
    afterOpen(
      (opened) => String(opened).includes(".atrium-config-"),
      async () => {
        await filesystem.unlink(alias);
        await symlink(second, alias);
      },
    );
    await expect(service.save(null, "settings.json", '{"edited":true}', initial.revision)).rejects.toMatchObject({
      code: "path_invalid",
    });
    expect(await readFile(initial.path, "utf8")).toBe("{}");
    expect(await readdir(first)).toStrictEqual(["settings.json"]);
    expect(await readdir(second)).toStrictEqual([]);
  });

  it("follows trusted global directory aliases and maps filesystem failures", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const linked = createPiConfig({
      environment: async () => ({ PI_CODING_AGENT_DIR: join(root, "alias", "agent") }),
      dirOf: () => undefined,
    });
    const canonical = join(root, "real", "agent", "settings.json");
    expect(await linked.read(null, "settings.json")).toMatchObject({ path: canonical, revision: null });
    expect(await linked.save(null, "settings.json", "{}", null)).toMatchObject({ path: canonical, text: "{}" });
    expect(await linked.read(null, "settings.json")).toMatchObject({ path: canonical, text: "{}" });
    const unavailable = createPiConfig({
      environment: async () => {
        throw new Error("private-path");
      },
      dirOf: () => undefined,
    });
    await expect(unavailable.read(null, "settings.json")).rejects.toMatchObject({ code: "config_unavailable" });
    await expect(unavailable.save(null, "settings.json", "{}", null)).rejects.toMatchObject({
      code: "config_unavailable",
    });
  });
});

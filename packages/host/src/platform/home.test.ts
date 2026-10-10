import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, realpath, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ensureAtriumHome } from "./home";

describe("ensureAtriumHome", () => {
  it("creates the home and its logs folder readable only by the owner", async () => {
    const parent = await createTempDir("home");
    onTestFinished(parent.cleanup);
    const root = join(parent.path, ".atrium");

    const home = await ensureAtriumHome(root);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(home.logs)).mode & 0o777).toBe(0o700);
    expect(home.looseModes).toStrictEqual([]);
  });

  it("leaves the mode of an existing directory alone and reports it when others can read it", async () => {
    const shared = await createTempDir("shared");
    onTestFinished(shared.cleanup);
    await chmod(shared.path, 0o755);
    await mkdir(join(shared.path, "logs"), { mode: 0o700 });

    const home = await ensureAtriumHome(shared.path);

    expect((await stat(shared.path)).mode & 0o777).toBe(0o755);
    expect(home.looseModes).toStrictEqual([await realpath(shared.path)]);
  });

  it("answers the home by its real path, as pi names the folders of the directories under it", async () => {
    const parent = await createTempDir("home");
    onTestFinished(parent.cleanup);
    const real = join(parent.path, "real");
    await mkdir(real, { mode: 0o700 });
    const linked = join(parent.path, "linked");
    await symlink(real, linked);

    const home = await ensureAtriumHome(linked);

    const root = await realpath(real);
    expect(home).toStrictEqual({ root, logs: join(root, "logs"), looseModes: [] });
  });
});

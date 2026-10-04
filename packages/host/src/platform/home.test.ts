import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAtriumHome } from "./home";

describe("ensureAtriumHome", () => {
  it("creates the home and its logs folder readable only by the owner", async () => {
    const parent = await createTempDir("home");
    const root = join(parent.path, ".atrium");

    const home = await ensureAtriumHome(root);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(home.logs)).mode & 0o777).toBe(0o700);
    expect(home.looseModes).toStrictEqual([]);
    await parent.cleanup();
  });

  it("leaves the mode of an existing directory alone and reports it when others can read it", async () => {
    const shared = await createTempDir("shared");
    await chmod(shared.path, 0o755);
    await mkdir(join(shared.path, "logs"), { mode: 0o700 });

    const home = await ensureAtriumHome(shared.path);

    expect((await stat(shared.path)).mode & 0o777).toBe(0o755);
    expect(home.looseModes).toStrictEqual([shared.path]);
    await shared.cleanup();
  });
});

import { createTempDir, present, writeFakePiPackage } from "@atrium/testkit";
import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostTools } from "../src/setup/toolbox";

/** The login program as tests run it: the source file in `packages/pi`, which Node runs directly. */
export const LOGIN_WORKER = fileURLToPath(new URL("../../pi/src/auth/login-worker.ts", import.meta.url));

/**
 * Tools whose `pi` is a fake pi package run in a scenario, on the Node running the tests.
 *
 * @remarks
 * The `pi` command links into the package, as an installed one does, so the login program loads
 * the fake the way it loads the real pi.
 *
 * @sideEffects Creates a temporary directory.
 * @param scenario - What the fake pi does (`FAKE_PI`).
 * @param source - The package entry's source, when not the usual fake.
 * @returns The tools, the temporary directory and a cleanup that removes it.
 */
export async function fakePiTools(
  scenario: string,
  source?: string,
): Promise<{ tools: HostTools; dir: string; cleanup: () => Promise<void> }> {
  const temp = await createTempDir("fake-pi-tools");
  const dir = await realpath(temp.path);
  const fake = await writeFakePiPackage(dir, source);
  await symlink(fake.cli, join(dir, "pi"));
  return {
    dir,
    cleanup: temp.cleanup,
    tools: {
      env: { PATH: present(process.env["PATH"], "PATH"), FAKE_PI: scenario },
      envSource: "configured",
      pi: { status: "ready", piPath: join(dir, "pi"), version: [1, 0, 2] },
      node: { status: "ready", nodePath: process.execPath, version: [22, 19, 0] },
      homebrew: null,
      fd: null,
    },
  };
}

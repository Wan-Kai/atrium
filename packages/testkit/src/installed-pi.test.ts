import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { installedPi } from "./installed-pi";
import { createTempDir } from "./temp-dir";

/** The start of cmux's pi shim, as cmux writes it into its shim folder. */
const CMUX_SHIM = "#!/bin/bash\ncmux_wrapper='/Applications/cmux.app/Contents/Resources/bin/cmux-pi-wrapper'\n";

/**
 * Writes an executable `pi` with this content into a new folder.
 *
 * @remarks
 * Never run here, only found: macOS's first-run check of new executables does not come into it
 * (testing.md, "测试里的可执行文件").
 *
 * @sideEffects Creates the folder and the file.
 * @param folder - The folder.
 * @param content - The script.
 * @returns The file's path.
 */
async function writePi(folder: string, content: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = join(folder, "pi");
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}

describe("installedPi", () => {
  it("passes over cmux's pi shim before the real pi, in its own folder or anywhere else", async () => {
    const dir = await createTempDir("installed-pi");
    onTestFinished(dir.cleanup);
    const shims = join(dir.path, ".cmuxterm", "cmux-cli-shims", "4CF8A6E5");
    await writePi(shims, '#!/bin/sh\nexec pi "$@"\n');
    const elsewhere = join(dir.path, "copied-shim");
    await writePi(elsewhere, CMUX_SHIM);
    const real = await writePi(join(dir.path, "real"), "#!/usr/bin/env node\nconsole.log('pi');\n");

    expect(await installedPi([shims, elsewhere, join(dir.path, "real")].join(delimiter))).toBe(real);
  });

  it("passes over relative folders, folders named pi and files it cannot run, and says when there is none", async () => {
    const dir = await createTempDir("installed-pi");
    onTestFinished(dir.cleanup);
    await mkdir(join(dir.path, "folder", "pi"), { recursive: true });
    const plain = join(dir.path, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "pi"), "#!/bin/sh\n");

    // A relative entry that does reach a runnable pi from here.
    const relativeFolder = relative(process.cwd(), join(dir.path, "relative"));
    await writePi(join(dir.path, "relative"), "#!/usr/bin/env node\n");

    await expect(installedPi(["", relativeFolder, join(dir.path, "folder"), plain].join(delimiter))).rejects.toThrow(
      "pi is not on PATH",
    );
  });
});

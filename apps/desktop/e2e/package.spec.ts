import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { launchApp } from "./launch";

const run = promisify(execFile);
/** Where `pnpm package` puts the app for this machine. */
const bundle = join(import.meta.dirname, "..", "out", `Atrium-darwin-${process.arch}`, "Atrium.app");

/**
 * Returns the SHA-256 of a file, in hex.
 *
 * @remarks
 * Comparing the icon by hash keeps a failure's message short; the files are hundreds of KiB.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns Its hash.
 */
async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

test("@package runs from the packaged app, with the host, login program, UI and Atrium's icon inside it", async () => {
  await run("codesign", ["--verify", "--deep", "--strict", bundle]);
  const plist = JSON.parse(
    (await run("plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents", "Info.plist")])).stdout,
  ) as { CFBundleIconFile: string };
  expect(await sha256(join(bundle, "Contents", "Resources", plist.CFBundleIconFile))).toBe(
    await sha256(join(import.meta.dirname, "..", "assets", "icon.icns")),
  );
  const launched = await launchApp({}, undefined, { executablePath: join(bundle, "Contents", "MacOS", "Atrium") });

  try {
    const where = await launched.app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      appPath: app.getAppPath(),
    }));
    const appDir = join(bundle, "Contents", "Resources", "app");
    expect(where).toStrictEqual({ packaged: true, name: "Atrium", appPath: appDir });
    expect(launched.window.url()).toBe("atrium://app/");
    await access(join(appDir, "host", "login-worker.mjs"));
    await launched.quit();

    expect((await launched.readHostLog()).at(-1)).toMatchObject({ msg: "host stopped" });
  } finally {
    await launched.cleanup();
  }
});

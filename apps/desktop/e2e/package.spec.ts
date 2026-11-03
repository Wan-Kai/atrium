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

/** The code-signing identity `pnpm package` was told to use, if any. */
const identity = process.env.ATRIUM_CODESIGN_IDENTITY?.trim() ?? "";

test.describe("signed with a certificate", () => {
  test.skip(identity === "", "no signing identity set, so the app is signed ad hoc");

  test("@package signs with ATRIUM_CODESIGN_IDENTITY, so macOS keeps its permissions across rebuilds", async () => {
    // Which stream `codesign -d` writes to has varied between releases, so read both.
    const { stdout, stderr } = await run("codesign", ["-d", "-r-", bundle]);
    const requirement = stdout + stderr;
    expect(requirement).toContain('identifier "dev.atrium.app"');
    expect(requirement).toContain("certificate leaf");
    expect(requirement).not.toContain("cdhash");
  });
});

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

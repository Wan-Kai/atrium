import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
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

test.describe("the bundle's contents", () => {
  test("@package ships node-pty beside the host, with an executable spawn helper (SPEC-0009)", async () => {
    const pty = join(bundle, "Contents", "Resources", "app", "native", "node-pty");
    const manifest: unknown = JSON.parse(await readFile(join(pty, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "node-pty" });
    const helper = join(pty, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    expect((await stat(helper)).mode & 0o111).not.toBe(0);
    await access(join(pty, "lib", "index.js"));
  });
});

test("@package opens a terminal in the installed app and runs a shell in it (SPEC-0009)", async () => {
  const launched = await launchApp({}, undefined, { executablePath: join(bundle, "Contents", "MacOS", "Atrium") });
  try {
    const page = launched.window;
    await page.getByRole("button", { name: "新建对话" }).click();
    // The new chat becomes the shown session a moment later, which would take the viewer tab over.
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "新终端" }).click();
    // The chat's session may take the area over once it starts; the terminal's tab shows it again.
    await page.getByRole("tab", { name: /终端/ }).click();
    await page.waitForTimeout(1500);
    const screen = page.locator(".xterm-rows");
    await expect(screen).toBeVisible();
    // The shell prints its prompt once it has read its startup files; typing before that is lost.
    await page.waitForTimeout(2500);
    await page.locator(".xterm-screen").click();
    await page.keyboard.type("echo packaged-ok");
    await page.keyboard.press("Enter");
    // The shell is a real PTY in the packaged app: node-pty and its spawn helper are inside it.
    await expect(screen).toContainText("packaged-ok", { timeout: 20_000 });
    await launched.quit();
  } finally {
    await launched.cleanup();
  }
});

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

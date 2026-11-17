import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const desktop = import.meta.dirname;
const repo = join(desktop, "..", "..");

/**
 * Lays out the app directory: the main process and preload, the host and its login program, and the UI.
 *
 * @remarks
 * Everything is a bundle already (`pnpm build`), so no `node_modules` goes in; the main process
 * finds the host and UI here when packaged (overview.md, "桌面端怎么启动宿主"). Source maps stay
 * out to keep the app small.
 *
 * @sideEffects Creates and fills a temporary directory.
 * @returns {Promise<string>} The directory.
 */
async function stageApp() {
  const stage = await mkdtemp(join(tmpdir(), "atrium-package-"));
  const own = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const manifest = { name: "atrium", productName: own.productName, version: own.version, main: own.main };
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ["main.cjs", "preload.cjs"]) await cp(join(desktop, "dist", file), join(stage, "dist", file));
  for (const file of ["entry.cjs", "login-worker.mjs", "atrium-extension.mjs"]) {
    await cp(join(repo, "packages", "host", "dist", file), join(stage, "host", file));
  }
  await cp(join(repo, "packages", "ui", "dist"), join(stage, "ui"), { recursive: true });
  await stageTerminal(stage);
  return stage;
}

/**
 * Puts node-pty beside the host, for terminals (SPEC-0009).
 *
 * @remarks
 * A native addon cannot be inlined into the host's bundle, and `app.asar`-free is already the
 * rule here. Only the package's JS, its manifest and this machine's prebuilt binary are copied:
 * 412 KiB, where the whole package is 62 MiB of sources. `spawn-helper` arrives from npm without
 * its execute bit, so it is set here as well as at run time.
 *
 * @sideEffects Creates `native/node-pty` in the stage and changes a mode.
 * @param stage - The app directory being laid out.
 */
async function stageTerminal(stage) {
  const from = join(repo, "packages", "host", "node_modules", "node-pty");
  const to = join(stage, "native", "node-pty");
  for (const file of ["package.json", "lib"]) {
    await cp(join(from, file), join(to, file), { recursive: true });
  }
  const platform = `${process.platform}-${process.arch}`;
  await cp(join(from, "prebuilds", platform), join(to, "prebuilds", platform), { recursive: true });
  await chmod(join(to, "prebuilds", platform, "spawn-helper"), 0o755);
}

/**
 * Signs the app and says which identity it used.
 *
 * @remarks
 * Ad hoc (`--sign -`) records a designated requirement made of the bundle's cdhash, which changes
 * with every build: macOS then treats the next install as a different app and asks again for the
 * "files and folders" permissions it was granted, once per protected folder (development.md, "本机
 * 打包"). Signing with a certificate puts the bundle id and that certificate in the requirement
 * instead, so one grant outlives rebuilds. `ATRIUM_CODESIGN_IDENTITY` names one of
 * `security find-identity -v -p codesigning`; unset or empty keeps the ad hoc behaviour.
 *
 * @sideEffects Runs `codesign` over the bundle, including its nested helpers.
 * @param bundle - The app to sign.
 * @returns What it signed with, for the line on stderr.
 * @throws When `codesign` fails, which includes an identity the keychain does not have.
 */
async function sign(bundle) {
  const identity = process.env.ATRIUM_CODESIGN_IDENTITY?.trim() ?? "";
  await run("codesign", ["--force", "--deep", "--sign", identity === "" ? "-" : identity, bundle]);
  return identity === "" ? "ad hoc" : identity;
}

/**
 * Packages Atrium.app for this machine and signs it.
 *
 * @remarks
 * For use on this Mac only (overview.md, "桌面端怎么启动宿主"): Apple Silicon runs only signed
 * code, and changing the bundle's name and plist breaks Electron's own signature, so the whole app
 * is signed again; it is not notarized. No asar: the system Node runs the login program, and it
 * cannot read one. The icon is Atrium's cat (design-language.md, "标志").
 *
 * @remarks
 * `ATRIUM_ELECTRON_ZIP_DIR` names a directory holding `electron-v<version>-<platform>-<arch>.zip`,
 * so a machine without the network can package from a cached download instead of fetching one.
 *
 * @sideEffects Replaces `out/Atrium-darwin-<arch>`; runs `codesign`; prints the app's path.
 */
async function packageApp() {
  const stage = await stageApp();
  try {
    const electron = JSON.parse(await readFile(join(desktop, "node_modules", "electron", "package.json"), "utf8"));
    const [outDir] = await packager({
      dir: stage,
      out: join(desktop, "out"),
      name: "Atrium",
      appBundleId: "dev.atrium.app",
      icon: join(desktop, "assets", "icon.icns"),
      platform: "darwin",
      arch: process.arch,
      electronVersion: electron.version,
      asar: false,
      prune: false,
      overwrite: true,
      quiet: true,
      ...(process.env["ATRIUM_ELECTRON_ZIP_DIR"] === undefined
        ? {}
        : { electronZipDir: process.env["ATRIUM_ELECTRON_ZIP_DIR"] }),
    });
    const bundle = join(outDir, "Atrium.app");
    console.error(`signed with ${await sign(bundle)}`);
    console.log(bundle);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

await packageApp();

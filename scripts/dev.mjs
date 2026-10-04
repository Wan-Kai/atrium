import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const devPort = Number(process.env.ATRIUM_DEV_PORT ?? 5791);
const devUrl = `http://127.0.0.1:${devPort}`;

/**
 * Runs a Node script to completion.
 *
 * @remarks
 * Node entry points are started through `process.execPath`, never through `npx` or `.bin` shims
 * (overview.md, "宿主内部的依赖").
 *
 * @sideEffects Spawns a child process that inherits stdio.
 * @param {string} script - Script path relative to `cwd`.
 * @param {string} cwd - Working directory.
 * @returns {Promise<void>} Resolves when it exits with code 0.
 */
function runOnce(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: "inherit" });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
  });
}

/**
 * Fails when the dev port is already taken.
 *
 * @remarks
 * Polling the port would otherwise succeed against whatever else listens there and open Electron
 * on a stranger's page.
 *
 * @sideEffects Briefly listens on the port.
 * @param {number} port - Port Vite will use.
 * @returns {Promise<void>} Resolves when the port is free.
 */
function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`port ${port} is in use; set ATRIUM_DEV_PORT to another port`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

/**
 * Waits until an HTTP server answers.
 *
 * @remarks
 * Electron must not open the window before Vite serves the page.
 *
 * @sideEffects Polls the URL.
 * @param {string} url - Address to poll.
 * @returns {Promise<void>} Resolves once a request succeeds.
 */
async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await fetch(url).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not start`);
}

/**
 * Starts the development loop: Vite for the UI with hot reload, plus Electron with a freshly built host.
 *
 * @remarks
 * The host and the Electron main process are rebuilt on each start; restart `pnpm dev` after
 * changing them. The page comes from Vite, whose origin the host allows explicitly (security.md).
 *
 * @sideEffects Builds the host and desktop bundles; spawns Vite and Electron; stops both when
 * either exits or on Ctrl+C.
 */
async function main() {
  await ensurePortFree(devPort);
  await runOnce("build.mjs", join(root, "packages", "host"));
  await runOnce("build.mjs", join(root, "apps", "desktop"));
  const vite = spawn(process.execPath, [join(root, "packages", "ui", "node_modules", "vite", "bin", "vite.js")], {
    cwd: join(root, "packages", "ui"),
    stdio: "inherit",
    env: { ...process.env, ATRIUM_DEV_PORT: String(devPort) },
  });
  const viteExited = new Promise((resolve) => vite.once("exit", resolve));
  const started = await Promise.race([waitForServer(devUrl).then(() => true), viteExited.then(() => false)]);
  if (!started) throw new Error("Vite exited during startup");
  const electron = spawn(process.execPath, [join(root, "apps", "desktop", "node_modules", "electron", "cli.js"), "."], {
    cwd: join(root, "apps", "desktop"),
    stdio: "inherit",
    env: { ...process.env, ATRIUM_DEV_URL: devUrl },
  });
  let stopped = false;
  /**
   * Stops both child processes once.
   *
   * @remarks
   * Either one exiting, Ctrl+C or a SIGTERM ends the dev session, so nothing is left holding the
   * dev port. Calling it again does nothing.
   *
   * @sideEffects Kills Vite and Electron.
   */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    vite.kill();
    electron.kill();
  };
  electron.once("exit", stop);
  vite.once("exit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

await main();

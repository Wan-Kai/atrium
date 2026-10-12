import { build } from "esbuild";

/**
 * Bundles one host entry point into a single CommonJS file.
 *
 * @remarks
 * A single file avoids `app.asar` missing undeclared peer dependencies at runtime, which Paseo hit
 * (overview.md, "桌面端怎么启动宿主"). The optional native accelerators of `ws` are left out; `ws`
 * works without them. The `pnpm pi:try` command imports the host's TypeScript sources and
 * workspace packages, which Node cannot load directly, so it is bundled the same way.
 *
 * @sideEffects Writes `outfile` and its source map.
 * @param {string} entryPoint - The source file.
 * @param {string} outfile - The bundle to write.
 * @returns {Promise<void>} Once the bundle is written.
 */
async function bundle(entryPoint, outfile) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

/**
 * Writes the login program next to the host's bundle.
 *
 * @remarks
 * The system Node runs it, not the host, and it imports only Node built-ins and the user's pi at run
 * time (overview.md, "登录程序的例外"), so it is only stripped of types, not bundled. The host finds
 * it beside `entry.cjs`.
 *
 * @sideEffects Writes `dist/login-worker.mjs`.
 * @returns {Promise<void>} Once it is written.
 */
async function loginWorker() {
  await build({
    entryPoints: ["../pi/src/auth/login-worker.ts"],
    outfile: "dist/login-worker.mjs",
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
}

/**
 * Writes Atrium's Fast extension next to the host's bundle, as one file.
 *
 * @remarks
 * pi loads it in the sessions the host starts (`--extension`), not the host (overview.md, "Atrium
 * 自带的 pi 扩展"); the rule of which models have Fast is bundled in, and nothing of pi is imported
 * at run time. The host finds it beside `entry.cjs`.
 *
 * @sideEffects Writes `dist/fast-extension.mjs`.
 * @returns {Promise<void>} Once it is written.
 */
async function fastExtension() {
  await build({
    entryPoints: ["../pi/src/fast/extension.ts"],
    outfile: "dist/fast-extension.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
}

await Promise.all([
  bundle("src/entry.ts", "dist/entry.cjs"),
  bundle("src/dev/try-pi.ts", "dist/try-pi.cjs"),
  loginWorker(),
  fastExtension(),
]);

import { build } from "esbuild";

/**
 * Bundles the host into one CommonJS file.
 *
 * @remarks
 * A single file avoids `app.asar` missing undeclared peer dependencies at runtime, which Paseo hit
 * (overview.md, "桌面端怎么启动宿主"). The optional native accelerators of `ws` are left out; `ws`
 * works without them.
 *
 * @sideEffects Writes `dist/entry.cjs` and its source map.
 */
async function bundleHost() {
  await build({
    entryPoints: ["src/entry.ts"],
    outfile: "dist/entry.cjs",
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
 * Bundles the `pnpm pi:try` development command.
 *
 * @remarks
 * It imports the host's TypeScript sources and workspace packages, which Node cannot load
 * directly, so it is bundled the same way as the host.
 *
 * @sideEffects Writes `dist/try-pi.cjs` and its source map.
 */
async function bundleTryPi() {
  await build({
    entryPoints: ["src/dev/try-pi.ts"],
    outfile: "dist/try-pi.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

await bundleHost();
await bundleTryPi();

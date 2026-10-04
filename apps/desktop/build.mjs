import { build } from "esbuild";

/**
 * Bundles the Electron main process and the preload script.
 *
 * @remarks
 * A sandboxed preload must be a single CommonJS file, and the main process is bundled the same
 * way for consistency; `electron` itself is provided at runtime.
 *
 * @sideEffects Writes `dist/main.cjs`, `dist/preload.cjs` and their source maps.
 */
async function bundleDesktop() {
  const shared = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: true,
    external: ["electron"],
    logLevel: "warning",
  };
  await Promise.all([
    build({ ...shared, entryPoints: ["src/main/main.ts"], outfile: "dist/main.cjs" }),
    build({ ...shared, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.cjs" }),
  ]);
}

await bundleDesktop();

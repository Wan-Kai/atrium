import { build } from "esbuild";

/**
 * Bundles the relay into one CommonJS file, `dist/relay.cjs`.
 *
 * @remarks
 * Same as the host's bundle (`packages/host/build.mjs`): one file to copy onto the VPS or into
 * the Docker image, no `node_modules` there. The optional native accelerators of `ws` are left
 * out; `ws` works without them.
 *
 * @sideEffects Writes `dist/relay.cjs` and its source map.
 * @returns {Promise<void>} Once written.
 */
async function bundle() {
  await build({
    entryPoints: ["src/entry.ts"],
    outfile: "dist/relay.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

await bundle();

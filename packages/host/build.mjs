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

await bundleHost();

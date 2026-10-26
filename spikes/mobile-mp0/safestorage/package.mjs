// Packages the spike as AtriumSpike.app with an ad-hoc signature, like `pnpm package` does for Atrium.
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [outDir] = await packager({
  dir: here,
  out: join(here, "out"),
  overwrite: true,
  platform: "darwin",
  arch: process.arch,
  asar: false,
  ignore: [/^\/out/, /package\.mjs$/],
  electronVersion: "44.5.1",
  appBundleId: "site.ktoon.atrium.spike",
});
const bundle = join(outDir, "AtriumSpike.app");
execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
console.log(bundle);

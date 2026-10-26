import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** The Vitest entry, or the stand-in this script's own test gives. */
const vitest = process.env["ATRIUM_TEST_VITEST"] ?? join(root, "node_modules", "vitest", "vitest.mjs");

/**
 * Runs the unit layer, then AtriumKit's Swift tests: `pnpm test`.
 *
 * @remarks
 * testing.md "Swift（手机端）": the Swift logic tests take seconds on macOS, so they run with the
 * unit layer and in lefthook's pre-push check. Arguments go to Vitest, and then only Vitest runs,
 * since they filter TypeScript tests (`pnpm test packages/protocol`). Without Xcode the Swift part
 * is skipped with a note (`scripts/ios.mjs kit --if-xcode`).
 *
 * @sideEffects Runs Vitest and maybe `swift test`; sets the exit code.
 */
function main() {
  const args = process.argv.slice(2);
  const unit = spawnSync(process.execPath, [vitest, "run", "--project", "unit", ...args], { stdio: "inherit" });
  if (unit.status !== 0 || args.length > 0) {
    process.exitCode = unit.status ?? 1;
    return;
  }
  const swift = spawnSync(process.execPath, [join(root, "scripts", "ios.mjs"), "kit", "--if-xcode"], {
    stdio: "inherit",
  });
  process.exitCode = swift.status ?? 1;
}

main();

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const fixturesDir = join(root, "packages", "pi", "fixtures");

/**
 * Re-records every pi fixture with the installed pi, then removes other versions' fixtures.
 *
 * @remarks
 * Only one pi version's fixtures stay in the repository, so the commit that re-records them shows
 * exactly how pi's output changed (testing.md, "pi 夹具"). The contract tests do the recording when
 * `RECORD_FIXTURES=1`; nothing is deleted if they fail.
 *
 * @sideEffects Runs pi and the pi contract tests; writes fixture files; deletes old version
 * directories; exits with the tests' status on failure.
 */
function recordFixtures() {
  const output = execFileSync("pi", ["--version"], { encoding: "utf8" });
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0];
  if (version === undefined) throw new Error(`pi --version printed no version: ${output}`);
  const run = spawnSync(
    process.execPath,
    [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--project", "pi", "packages/pi/src/contract"],
    { cwd: root, stdio: "inherit", env: { ...process.env, RECORD_FIXTURES: "1" } },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
  for (const dir of readdirSync(fixturesDir)) {
    if (dir !== `pi-${version}`) rmSync(join(fixturesDir, dir), { recursive: true, force: true });
  }
  console.log(`recorded fixtures for pi ${version}; review the diff before committing`);
}

recordFixtures();

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runnerImport } from "vite";
import { generateSwift } from "./swift-codegen.mjs";

const root = join(import.meta.dirname, "..");

/**
 * Where the generated Swift goes; `ATRIUM_PROTOCOL_SWIFT_OUT` points this script's own test elsewhere.
 */
const output =
  process.env["ATRIUM_PROTOCOL_SWIFT_OUT"] ??
  join(root, "apps", "ios", "AtriumKit", "Sources", "AtriumProtocol", "Generated", "Protocol.swift");

/** Case names for the unions told apart by a boolean. */
const caseNames = { ResponseMessage: { true: "success", false: "failure" } };

/**
 * Generates the Swift protocol types from `packages/protocol`, or checks the committed ones.
 *
 * @remarks
 * `pnpm protocol:swift` (testing.md, "协议类型的生成与往返测试"; ADR-0015). The protocol is
 * TypeScript, which Node cannot load directly, so it goes through Vite's module runner (Vite is
 * already a dev dependency). `--check` compares in memory and exits 1 on any difference; it needs
 * only Node, so `pnpm check` runs it on machines without Xcode too. Without `--check`, it also
 * rewrites the round-trip fixtures by running the protocol's envelope tests with
 * `UPDATE_SWIFT_FIXTURES=1`.
 *
 * @sideEffects Reads the protocol; without `--check`, writes the Swift file and runs Vitest, which
 * writes the fixtures; prints a line; sets the exit code.
 */
async function main() {
  const { module } = await runnerImport(join(root, "packages", "protocol", "src", "json-schema.ts"));
  const swift = generateSwift(module.protocolJsonSchema(), { caseNames });
  const name = relative(root, output);
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(output, "utf8");
    } catch {
      // A missing file is a difference like any other.
    }
    if (committed === swift) return;
    console.log(`${name} is out of date with packages/protocol; run pnpm protocol:swift`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(output, swift);
  console.log(`wrote ${name}`);
  const run = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--project",
      "unit",
      "packages/protocol/src/envelope.test.ts",
      "-t",
      "Swift fixtures",
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, UPDATE_SWIFT_FIXTURES: "1" } },
  );
  if (run.status !== 0) process.exitCode = run.status ?? 1;
}

await main();

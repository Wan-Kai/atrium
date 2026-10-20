import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "break-check.mjs");

/**
 * A folder with a source file and a stand-in for Vitest.
 *
 * @remarks
 * The stand-in fails the test, printing a "×" line as Vitest does, while the source holds
 * `broken`, and records each run's arguments, so the real Vitest never runs.
 *
 * @sideEffects Makes a temporary folder, removed when the test ends.
 * @returns The folder, the source file and the stand-in.
 */
async function scene() {
  const dir = await mkdtemp(join(tmpdir(), "atrium-break-check-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "add.ts");
  await writeFile(source, "export const add = (a, b) => a + b;\nexport const label = 'sum';\n");
  const runner = join(dir, "runner.mjs");
  await writeFile(
    runner,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(join(dir, "runs.txt"))}, process.argv.slice(2).join(" ") + "\\n");`,
      `const text = readFileSync(${JSON.stringify(source)}, "utf8");`,
      'if (text.includes("broken")) console.log("   × adds two numbers 3ms");',
      'else console.log("   ✓ adds two numbers 3ms");',
    ].join("\n"),
  );
  return { dir, source, runner };
}

/**
 * Runs the script on these cases with the stand-in, never failing on its exit code.
 *
 * @sideEffects Runs the script, which edits and restores the source.
 * @param dir - Where the cases file goes.
 * @param runner - The stand-in for Vitest.
 * @param cases - The cases.
 * @returns What it printed and its exit code.
 */
async function check(dir: string, runner: string, cases: unknown) {
  const file = join(dir, "cases.json");
  await writeFile(file, JSON.stringify(cases));
  return run(process.execPath, [script, file], { env: { ...process.env, ATRIUM_BREAK_CHECK_RUNNER: runner } }).then(
    ({ stdout }) => ({ stdout, code: 0 }),
    (error: unknown) => ({
      stdout: String(Reflect.get(Object(error), "stdout")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
}

describe("break-check", () => {
  it("breaks the code as each case says, runs the named test, reports caught and missed, and restores the file", async () => {
    const { dir, source, runner } = await scene();
    const before = await readFile(source, "utf8");

    const result = await check(dir, runner, [
      { file: source, from: "a + b", to: "a - b /* broken */", test: "add.test.ts", name: "adds" },
      { file: source, from: "'sum'", to: "'total'", test: "add.test.ts", name: "adds", project: "ui" },
    ]);

    expect([
      result.stdout.trim().split("\n"),
      result.code,
      await readFile(source, "utf8"),
      (await readFile(join(dir, "runs.txt"), "utf8")).trim().split("\n"),
    ]).toStrictEqual([
      ["CAUGHT | add.ts | a + b -> × adds two numbers", "MISSED | add.ts | 'sum'", "1 of 2 missed"],
      1,
      before,
      ["run --project unit add.test.ts -t adds", "run --project ui add.test.ts -t adds"],
    ]);
  });

  it("refuses a case whose text is not in the file exactly once, before changing anything", async () => {
    const { dir, source, runner } = await scene();
    const before = await readFile(source, "utf8");

    const result = await check(dir, runner, [
      { file: source, from: "export", to: "x", test: "add.test.ts", name: "adds" },
    ]);

    expect([result.stdout.trim(), result.code, await readFile(source, "utf8")]).toStrictEqual([
      "not exactly once in add.ts: export",
      2,
      before,
    ]);
  });
});

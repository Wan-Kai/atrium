import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "test.mjs");

/**
 * Runs `scripts/test.mjs` with stand-ins for Vitest and `xcrun` that log their arguments.
 *
 * @remarks
 * Neither Vitest nor Swift really runs. The Vitest stand-in exits with `vitestCode`; the `xcrun`
 * one says whether Xcode is there.
 *
 * @sideEffects Makes a temporary folder, removed when the test ends; runs the script.
 * @param args - The script's arguments.
 * @param options - The stand-ins' exit codes.
 * @returns The exit code and the logged calls, `vitest …` or `xcrun …`.
 */
async function test(args: string[], options: { vitestCode?: number; xcode?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "atrium-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.txt");
  const standIn = (name: string, code: string) =>
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");`,
      code,
    ].join("\n");
  const vitest = join(dir, "vitest.mjs");
  const xcrun = join(dir, "xcrun.mjs");
  await writeFile(vitest, standIn("vitest", `process.exit(${options.vitestCode ?? 0});`));
  await writeFile(
    xcrun,
    standIn("xcrun", `if (process.argv[2] === "--find") process.exit(${options.xcode === false ? 1 : 0});`),
  );
  const env = { ...process.env, ATRIUM_TEST_VITEST: vitest, ATRIUM_IOS_XCRUN: xcrun };
  const code = await run(process.execPath, [script, ...args], { env }).then(
    () => 0,
    (error: unknown) => Number(Reflect.get(Object(error), "code")),
  );
  const calls = (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
  return { code, calls };
}

describe("test.mjs", () => {
  it("runs the unit layer, then AtriumKit's Swift tests", async () => {
    const { code, calls } = await test([]);

    expect(code).toBe(0);
    expect(calls[0]).toBe("vitest run --project unit");
    expect(calls.at(-1)).toMatch(/^xcrun swift test --package-path \S+AtriumKit /u);
  });

  it("runs only Vitest, with the arguments, when given any", async () => {
    const { calls } = await test(["packages/protocol", "--no-file-parallelism"]);

    expect(calls).toStrictEqual(["vitest run --project unit packages/protocol --no-file-parallelism"]);
  });

  it("stops with Vitest's exit code when the unit layer fails", async () => {
    const { code, calls } = await test([], { vitestCode: 3 });

    expect(code).toBe(3);
    expect(calls).toStrictEqual(["vitest run --project unit"]);
  });

  it("skips the Swift tests without Xcode and still passes", async () => {
    const { code, calls } = await test([], { xcode: false });

    expect(code).toBe(0);
    expect(calls).toStrictEqual(["vitest run --project unit", "xcrun --find xcodebuild"]);
  });
});

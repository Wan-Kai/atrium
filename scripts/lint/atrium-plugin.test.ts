import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const oxlint = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "oxlint");
const plugin = join(import.meta.dirname, "atrium-plugin.mjs");

/**
 * Lints one file with only `atrium/side-effects-none` on, as `pnpm lint` loads the plugin.
 *
 * @remarks
 * Runs the real oxlint, so the rule is tested against the AST and comments oxlint hands it.
 *
 * @sideEffects Makes a temporary folder, removed when the test ends; runs oxlint.
 * @param source - The file's text.
 * @returns The reported `line:column call` entries.
 */
async function lint(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-lint-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ plugins: [], jsPlugins: [plugin], rules: { "atrium/side-effects-none": "error" } }),
  );
  await writeFile(join(dir, "code.ts"), source);
  const stdout = await run(oxlint, ["-c", "config.json", "-f", "unix", "code.ts"], { cwd: dir }).then(
    (result) => result.stdout,
    (error: unknown) => String(Reflect.get(Object(error), "stdout")),
  );
  return [...stdout.matchAll(/^code\.ts:(\d+:\d+): .*calls `([^`]+)`/gm)].map((match) => `${match[1]} ${match[2]}`);
}

/**
 * A function with a JSDoc block whose `@sideEffects` says `effects`.
 *
 * @sideEffects none
 * @param effects - The `@sideEffects` text.
 * @param body - The function, starting at its declaration.
 * @returns The source: the block's seven lines, then `body`.
 */
function documented(effects: string, body: string): string {
  return ["/**", " * Does a thing.", " *", " * @remarks", " * Why.", ` * @sideEffects ${effects}`, " */", body].join(
    "\n",
  );
}

describe("atrium/side-effects-none", () => {
  it("reports each side-effecting call a function documented `@sideEffects none` makes itself or in a callback it passes on", async () => {
    const source = [
      'import { spawn as start } from "node:child_process";',
      'import * as fs from "node:fs/promises";',
      'import { request } from "node:https";',
      "export class Box {",
      "  logger = console;",
      documented(
        "none",
        [
          "  run(clock: any): void {",
          "    start('ls');",
          "    void fs.writeFile('a', 'b');",
          "    request('x');",
          "    void fetch('x');",
          "    clock.setTimeout(() => {}, 1);",
          "    void new Promise((resolve) => setTimeout(resolve, 1));",
          "    ['a'].forEach((path) => fs.rm(path));",
          "    process.exit(1);",
          "    process.kill(1);",
          "    this.logger.warn('x');",
          "    console.log('x');",
          "    new WebSocket('x');",
          "  }",
          "}",
        ].join("\n"),
      ),
    ].join("\n");

    expect(await lint(source)).toStrictEqual([
      "14:5 start",
      "15:10 fs.writeFile",
      "16:5 request",
      "17:10 fetch",
      "18:5 clock.setTimeout",
      "19:35 setTimeout",
      "20:29 fs.rm",
      "21:5 process.exit",
      "22:5 process.kill",
      "23:5 logger.warn",
      "24:5 console.log",
      "25:5 new WebSocket",
    ]);
  });

  it("leaves alone look-alikes, closures that run later, signal 0 and functions that describe their effects", async () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      "const rm = (path: string) => path;",
      "export const pattern = /a/;",
      documented(
        "none",
        [
          "export function pure(pid: number) {",
          "  pattern.exec('a');",
          "  rm('a');",
          "  void readFile('a');",
          "  process.kill(pid, 0);",
          "  const later = () => setTimeout(() => {}, 1);",
          "  return { later, stored: { run: () => fetch('x') } };",
          "}",
        ].join("\n"),
      ),
      documented("none until `run`; then spawns git", "export function lazy() {\n  return fetch('x');\n}"),
      documented("Fetches the page.", "export const page = () => fetch('x');"),
      "export function undocumented() {\n  return fetch('x');\n}",
    ].join("\n");

    expect(await lint(source)).toStrictEqual([]);
  });
});

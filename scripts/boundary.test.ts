import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "boundary.mjs");
const repoRoot = join(import.meta.dirname, "..");
const plugin = join(import.meta.dirname, "lint", "atrium-plugin.mjs");

/**
 * The environment the scenes' git runs with.
 *
 * @remarks
 * Leaves out the developer's git configuration and stops git from finding Atrium's own checkout
 * above the scene, as the test kit's git scenes do.
 *
 * @sideEffects none
 * @param root - The scene.
 * @returns The environment.
 */
function sceneEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Atrium Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Atrium Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

/**
 * Makes an empty git repository on `main` in a temporary folder.
 *
 * @sideEffects Makes a folder, removed when the test ends; runs git.
 * @returns The folder.
 */
async function scene(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-boundary-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  return root;
}

/**
 * Runs git in a scene.
 *
 * @sideEffects Runs git, which may change the scene.
 * @param root - The scene.
 * @param args - git's arguments.
 */
async function git(root: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd: root, env: sceneEnv(root) });
}

/**
 * Writes files into a scene, making folders as needed.
 *
 * @sideEffects Writes files.
 * @param root - The scene.
 * @param files - Contents by path.
 */
async function put(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/**
 * Commits everything in a scene.
 *
 * @sideEffects Runs git.
 * @param root - The scene.
 * @param message - The commit message.
 */
async function commit(root: string, message: string): Promise<void> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
}

/**
 * Runs `pnpm boundary` in a folder, never failing on its exit code.
 *
 * @sideEffects Runs the script, which runs git and oxlint.
 * @param cwd - Where it runs.
 * @param args - Its arguments.
 * @returns What it printed and its exit code.
 */
async function boundary(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return run(process.execPath, [script, ...args], { cwd, env: sceneEnv(cwd) }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error: unknown) => ({
      stdout: String(Reflect.get(Object(error), "stdout")),
      stderr: String(Reflect.get(Object(error), "stderr")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
}

/**
 * A registry table with these items in its first column.
 *
 * @sideEffects none
 * @param items - The items; one already starting with a backtick is the whole first cell.
 * @returns The table's lines.
 */
function table(items: string[]): string[] {
  return [
    "| 名字 | 用途 |",
    "|---|---|",
    ...items.map((item) => (item.startsWith("`") ? `| ${item} | x |` : `| \`${item}\` | x |`)),
  ];
}

/**
 * The security document with the given registry rows.
 *
 * @sideEffects none
 * @param rows - The first column of each table, by table.
 * @returns The document.
 */
function security(rows: { urls: string[]; env: string[]; commands: string[] }): string {
  return [
    "# 安全基线",
    "",
    "## 外部边界登记",
    "",
    "### 出网地址",
    "",
    ...table(rows.urls),
    "",
    "### 环境变量",
    "",
    ...table(rows.env),
    "",
    "### 隐藏命令",
    "",
    ...table(rows.commands),
    "",
    "## 测试",
    "",
    "| `https://not-a-row.example` | belongs to another section |",
    "",
  ].join("\n");
}

/** Production code full of look-alikes that are not boundaries, plus a few that are. */
const TRICKY_SOURCE = [
  'import { NAMES } from "./names";',
  "// https://line-comment.example/x",
  "/** See https://jsdoc.example/y and `process.env.COMMENT_ONLY`. */",
  'export const LATEST = "https://pi.dev/api/latest-version";',
  "const pattern = /https:\\/\\/regex\\.example/;",
  "const origin = (port: number) => `http://127.0.0.1:${port}`;",
  'const scheme = "only http:// or https:// as a prefix";',
  'const home = process.env["ATRIUM_HOME"] ?? process.env.HOME;',
  "const base = import.meta.env.BASE_URL;",
  'const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", PATH: "/bin" };',
  'const key = "DEEPSEEK_SEARCH_API_KEY";',
  'const prefix = "ATRIUM_";',
  "const label = `Run curl -fsSL https://pi.dev/install.sh, then sh.`;",
  'const METHODS = ["GET", "POST"];',
  'const proxy = (toolEnv: Record<string, string>) => toolEnv["no_proxy"];',
  'const closed = (error: { code?: string }) => error.code === "ERR_STREAM_PREMATURE_CLOSE" || ["ERR_A", "ERR_"].length;',
  "export { pattern, origin, scheme, home, base, env, key, prefix, label, NAMES, METHODS, proxy, closed };",
  "",
].join("\n");

describe("pnpm boundary --all", () => {
  it("lists the production URLs, variables and hidden commands the registry lacks, reading code but not comments, regexes, error codes, composed rows, tests or other folders", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({
        urls: ["http://127.0.0.1:*", "https://gone.example", "`<login baseUrl>/usage` （拼出）"],
        env: ["HOME", "PATH", "ATRIUM_*"],
        commands: ["/atrium-plan"],
      }),
      "packages/host/src/net.ts": TRICKY_SOURCE,
      "packages/host/src/names.ts": 'export const NAMES = ["LC_ALL", "USER"];\n',
      "packages/pi/src/fast.ts": 'export const FAST_COMMAND = "atrium-fast";\n',
      "packages/pi/src/ext.ts": [
        'import { FAST_COMMAND as FAST } from "./fast";',
        "export function register(pi: any) {",
        "  pi.registerCommand(FAST, {});",
        '  pi.registerCommand("atrium-plan", {});',
        "}",
        "",
      ].join("\n"),
      "packages/ui/src/link.tsx": [
        'export const Link = () => <a href="https://ui.example/help">pi</a>;',
        "export const Text = () => <p>see https://ui.example/text</p>;",
        "",
      ].join("\n"),
      "packages/host/src/net.test.ts": 'const a = "https://test-only.example"; process.env.TEST_ONLY_VAR;\n',
      "packages/host/src/bench.bench.ts": 'const a = "https://bench.example";\n',
      "packages/ui/src/test/fake.ts": 'const a = "https://fake.example";\n',
      "packages/pi/src/contract/scenario.ts": 'pi.registerCommand("contract-only", {});\n',
      "packages/testkit/src/kit.ts": 'const a = "https://testkit.example";\n',
      "scripts/dev.mjs": "process.env.ATRIUM_DEV_PORT;\n",
      "package.json": JSON.stringify({ dependencies: { left: "1.2.3" }, devDependencies: { loose: "^2.0.0" } }),
      "packages/host/package.json": JSON.stringify({ dependencies: { "@atrium/pi": "workspace:*", tilde: "~1.0.0" } }),
    });
    await git(root, "add", "-A");

    const result = await boundary(root, "--all");

    expect([result.stdout, result.code]).toStrictEqual([
      [
        "Unregistered URLs:",
        "  https://pi.dev/api/latest-version  packages/host/src/net.ts:4",
        "  https://pi.dev/install.sh  packages/host/src/net.ts:13",
        "  https://ui.example/help  packages/ui/src/link.tsx:1",
        "  https://ui.example/text  packages/ui/src/link.tsx:2",
        "Unregistered environment variables:",
        "  ATRIUM_HOME  packages/host/src/net.ts:8",
        "  DEEPSEEK_SEARCH_API_KEY  packages/host/src/net.ts:11",
        "  GIT_TERMINAL_PROMPT  packages/host/src/net.ts:10",
        "  LC_ALL  packages/host/src/names.ts:1",
        "  USER  packages/host/src/names.ts:1",
        "  no_proxy  packages/host/src/net.ts:15",
        "Unregistered hidden commands:",
        "  /atrium-fast  packages/pi/src/ext.ts:3",
        "Dependencies without an exact version:",
        "  package.json devDependencies: loose ^2.0.0",
        "  packages/host/package.json dependencies: tilde ~1.0.0",
        "Registered but not found in production code:",
        "  URL https://gone.example",
        "boundary --all: URLs 5, environment variables 9, hidden commands 2; unregistered 11, not exact 2",
        "",
      ].join("\n"),
      1,
    ]);
  });

  it("passes with one summary line when everything is registered and exact", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({
        urls: ["https://pi.dev/api/latest-version"],
        env: ["ATRIUM_HOME"],
        commands: ["/atrium-fast"],
      }),
      "apps/desktop/src/main.ts": [
        'const url = "https://pi.dev/api/latest-version";',
        'const home = process.env["ATRIUM_HOME"];',
        'pi.registerCommand("atrium-fast", {});',
        "",
      ].join("\n"),
      "package.json": JSON.stringify({ devDependencies: { exact: "1.2.3", pre: "1.0.0-beta.2" } }),
    });

    const result = await boundary(root, "--all");

    expect([result.stdout, result.code]).toStrictEqual([
      "boundary --all: URLs 1, environment variables 1, hidden commands 1; unregistered 0, not exact 0\n",
      0,
    ]);
  });

  it("finds every production URL, variable and hidden command of this repository in the security registry", async () => {
    const result = await boundary(repoRoot, "--all");

    expect([result.stdout.split("\n").at(-2)?.replace(/^.*; /, ""), result.code, result.stderr]).toStrictEqual([
      "unregistered 0, not exact 0",
      0,
      "",
    ]);
  });
});

describe("pnpm boundary (changes)", () => {
  it("lists dependency, URL, variable, hidden command and protocol changes since the merge-base with main, committed or not", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({
        urls: ["https://kept.example", "https://old.example"],
        env: ["HOME"],
        commands: [],
      }),
      ".oxlintrc.json": JSON.stringify({
        plugins: [],
        jsPlugins: [plugin],
        rules: { "atrium/side-effects-none": "error" },
      }),
      "package.json": JSON.stringify({ devDependencies: { vitest: "5.0.3", gone: "1.0.0" } }),
      "packages/host/package.json": JSON.stringify({ dependencies: { ws: "8.22.0" } }),
      "packages/protocol/src/version.ts": "export const PROTOCOL_VERSION = 25;\n",
      "packages/protocol/src/events.ts": "export const A = 1;\n",
      "packages/host/src/net.ts": [
        'export const KEPT = "https://kept.example";',
        'export const OLD = "https://old.example";',
        "export const home = process.env.HOME;",
        "",
      ].join("\n"),
    });
    await commit(root, "base");
    await git(root, "switch", "-q", "-c", "feature");
    await put(root, {
      "packages/host/src/net.ts": [
        'export const KEPT = "https://kept.example";',
        'export const NEW = "https://new.example/api";',
        "export const home = process.env.HOME;",
        "",
      ].join("\n"),
      "packages/protocol/src/events.ts": "export const A = 2;\n",
    });
    await commit(root, "change");
    await put(root, {
      "package.json": JSON.stringify({ devDependencies: { vitest: "5.0.4", added: "^1.0.0" } }),
      "packages/host/package.json": JSON.stringify({ dependencies: { ws: "8.22.0", undici: "8.10.2" } }),
      "packages/host/src/timer.ts": [
        "/**",
        " * Waits.",
        " *",
        " * @remarks",
        " * Test.",
        " *",
        " * @sideEffects none",
        " */",
        "export function wait(): Promise<void> {",
        "  return new Promise((resolve) => setTimeout(resolve, 1));",
        "}",
        'export const token = process.env["ATRIUM_TOKEN"];',
        "",
      ].join("\n"),
      "packages/pi/src/ext.ts": 'pi.registerCommand("atrium-new", {});\n',
    });

    const result = await boundary(root);

    expect([result.stdout.replace(/[0-9a-f]{7}/, "<sha>"), result.code]).toStrictEqual([
      [
        "Boundary changes since <sha> (merge-base of HEAD and main)",
        "",
        "Dependencies:",
        "  + package.json devDependencies: added ^1.0.0  NOT EXACT",
        "  - package.json devDependencies: gone 1.0.0",
        "  ~ package.json devDependencies: vitest 5.0.3 -> 5.0.4",
        "  + packages/host/package.json dependencies: undici 8.10.2",
        "URLs:",
        "  + https://new.example/api  packages/host/src/net.ts:2  UNREGISTERED",
        "  - https://old.example  still registered",
        "Environment variables:",
        "  + ATRIUM_TOKEN  packages/host/src/timer.ts:12  UNREGISTERED",
        "Hidden commands:",
        "  + /atrium-new  packages/pi/src/ext.ts:1  UNREGISTERED",
        "Protocol version: 25 (unchanged)",
        "  WARNING: packages/protocol/src changed but PROTOCOL_VERSION did not",
        "@sideEffects contradictions in changed files:",
        "  packages/host/src/timer.ts:10:35: `@sideEffects none`, but the function calls `setTimeout`. Describe the side effect.",
        "Result: unregistered 3, not exact 1",
        "",
      ].join("\n"),
      1,
    ]);
  });

  it("takes an explicit base, shows a protocol bump and passes when every addition is registered", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({ urls: ["https://new.example"], env: [], commands: [] }),
      "packages/protocol/src/version.ts": "export const PROTOCOL_VERSION = 3;\n",
      "packages/protocol/src/version.test.ts": "export {};\n",
    });
    await commit(root, "first");
    await git(root, "tag", "first");
    await put(root, { "packages/client/src/a.ts": 'export const A = "https://new.example";\n' });
    await commit(root, "second");
    await put(root, {
      "packages/protocol/src/version.ts": "export const PROTOCOL_VERSION = 4;\n",
      "packages/protocol/src/version.test.ts": "export const changed = 1;\n",
    });

    const result = await boundary(root, "first");

    expect([result.stdout.replace(/[0-9a-f]{7}/, "<sha>"), result.code]).toStrictEqual([
      [
        "Boundary changes since first (<sha>)",
        "",
        "Dependencies:",
        "  (none)",
        "URLs:",
        "  + https://new.example  packages/client/src/a.ts:1  registered",
        "Environment variables:",
        "  (none)",
        "Hidden commands:",
        "  (none)",
        "Protocol version: 3 -> 4",
        "@sideEffects contradictions in changed files:",
        "  (not checked: no .oxlintrc.json)",
        "Result: unregistered 0, not exact 0",
        "",
      ].join("\n"),
      0,
    ]);
  });

  it("warns only for non-test protocol files changed without a version bump", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({ urls: [], env: [], commands: [] }),
      "packages/protocol/src/version.ts": "export const PROTOCOL_VERSION = 3;\n",
      "packages/protocol/src/envelope.test.ts": "export {};\n",
    });
    await commit(root, "first");
    await put(root, { "packages/protocol/src/envelope.test.ts": "export const changed = 1;\n" });

    const result = await boundary(root, "HEAD");

    expect([result.stdout.split("\n").filter((line) => line.includes("rotocol")), result.code]).toStrictEqual([
      ["Protocol version: 3 (unchanged)"],
      0,
    ]);
  });

  it("refuses a base that is not a commit", async () => {
    const root = await scene();
    await put(root, { "docs/architecture/security.md": security({ urls: [], env: [], commands: [] }) });
    await commit(root, "first");

    const result = await boundary(root, "no-such-ref");

    expect([result.stdout, result.stderr, result.code]).toStrictEqual(["", "boundary: not a commit: no-such-ref\n", 2]);
  });

  it("stops on production code it cannot parse instead of reporting nothing", async () => {
    const root = await scene();
    await put(root, {
      "docs/architecture/security.md": security({ urls: [], env: [], commands: [] }),
      "packages/host/src/broken.ts": "export const = ;\n",
    });

    const result = await boundary(root, "--all");

    expect([result.stdout, result.stderr.split(":").slice(0, 2).join(":"), result.code]).toStrictEqual([
      "",
      "boundary: cannot parse packages/host/src/broken.ts",
      2,
    ]);
  });
});

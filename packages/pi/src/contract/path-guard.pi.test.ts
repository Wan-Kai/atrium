import { createTempDir, present } from "@atrium/testkit";
import type { FauxContext } from "@atrium/testkit";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScenario } from "../../test/contract";
import { encodeArgument } from "../agent/agent";
import { outsideReason } from "../task/path-guard";

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/**
 * The host's flag telling the extension who the session is, for a `work` child.
 *
 * @sideEffects none
 * @param isolated - The flag's `isolated`; left out when `undefined`.
 * @returns The argument.
 */
function flag(isolated: boolean | undefined): string {
  const self = {
    v: 1,
    child: true,
    role: "work",
    depth: 1,
    guard: "flags",
    ...(isolated === undefined ? {} : { isolated }),
  };
  return `--atrium-agent=${encodeArgument(self)}`;
}

/**
 * The tool results a request carried after the last assistant message, as text.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns One entry per result, in order.
 */
function latestResults(request: FauxContext | undefined): { text: string; isError: boolean }[] {
  const messages = request?.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => Reflect.get(message as object, "role") === "assistant");
  return messages
    .slice(lastAssistant + 1)
    .filter((message) => Reflect.get(message as object, "role") === "toolResult")
    .map((message) => {
      const content: unknown = Reflect.get(message as object, "content");
      const text = Array.isArray(content)
        ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
        : "";
      return { text, isError: Reflect.get(message as object, "isError") === true };
    });
}

/** The writes of SPEC-0006's "验证 · 路径隔离" that must be blocked, by name and the path the model writes. */
type Attempt = readonly [name: string, path: (cwd: string, outside: string) => string];

const BLOCKED: readonly Attempt[] = [
  // Named after the working directory, so a run that does write it never meets another run's file.
  ["parent", (cwd) => `../outside-${basename(cwd)}.txt`],
  ["at-absolute", (_cwd, outside) => `@${outside}/at.txt`],
  ["tilde", () => "~/tilde.txt"],
  ["file-url", (_cwd, outside) => `file://${outside}/url.txt`],
  ["through-link", () => "link/new.txt"],
  ["git-config", () => ".git/config"],
];

/**
 * Runs a faux model that writes `ok.txt` and every attempt in one batch, in a `work` child's pi.
 *
 * @remarks
 * `outside` is a separate temporary directory and also pi's HOME, so `~` leads there and nothing
 * can reach the real home directory; `link` inside the working directory points at it.
 *
 * @sideEffects Creates and removes temporary directories; pi writes files in them.
 * @param args - pi's extra arguments (the host's flag, or none).
 * @param body - Called with the working directory, the outside directory and the model's requests.
 */
async function writeAll(
  args: readonly string[],
  body: (where: { cwd: string; outside: string; results: { text: string; isError: boolean }[] }) => Promise<void>,
): Promise<void> {
  const outside = await createTempDir("path-guard-outside");
  onTestFinished(outside.cleanup);
  await runScenario(
    {
      scenario: "path-guard",
      unrecorded: true,
      extensions: [ATRIUM_EXTENSION],
      args,
      env: { HOME: outside.path },
      files: { ".git/config": "[core]\n" },
      script: (cwd) => ({
        replies: [
          {
            blocks: [
              ["ok.txt", "./ok.txt"] as const,
              ...BLOCKED.map(([name, path]) => [name, path(cwd, outside.path)] as const),
            ].map(([, path], index) => ({
              type: "toolCall" as const,
              id: `call-${String(index + 1)}`,
              name: "write",
              arguments: { path: present(path, "path"), content: "written" },
            })),
          },
          { blocks: [{ type: "text" as const, text: "done" }] },
        ],
      }),
    },
    async ({ pi, until, cwd, contexts }) => {
      await mkdir(join(cwd, "sub"), { recursive: true });
      await symlink(outside.path, join(cwd, "link"), "dir");
      await pi.request({ type: "prompt", message: "go" });
      await until((event) => event.type === "agent_settled");
      const [, second] = await contexts();
      await body({ cwd, outside: outside.path, results: latestResults(second) });
    },
  );
}

describe("pi contract: the path guard in Atrium's extension (SPEC-0006, 路径隔离)", () => {
  it("blocks a work child's writes outside its directory and into .git, tells the model why, and lets ./ok.txt through", async () => {
    await writeAll([flag(true)], async ({ cwd, outside, results }) => {
      expect(existsSync(join(cwd, "..", `outside-${basename(cwd)}.txt`))).toBe(false);
      for (const stray of ["at.txt", "tilde.txt", "url.txt", "new.txt", "escape.txt"]) {
        expect(existsSync(join(outside, stray))).toBe(false);
      }
      expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
      expect(results).toHaveLength(BLOCKED.length + 1);
      expect(results[0]).toStrictEqual({ text: expect.stringContaining("Successfully wrote"), isError: false });
      for (const result of results.slice(1)) {
        expect(result).toStrictEqual({ text: outsideReason(cwd), isError: true });
      }
    });
  });

  it("keeps .git/config as it was", async () => {
    await writeAll([flag(true)], async ({ cwd }) => {
      expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe("[core]\n");
    });
  });

  it.each([
    ["a conversation the user opened (isolated false)", [flag(false)]],
    ["a flag without the field", [flag(undefined)]],
    ["pi in a terminal, with no host flag", []],
  ])("does nothing in %s", async (_name, args) => {
    await writeAll(args, async ({ cwd, outside, results }) => {
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(existsSync(join(outside, "at.txt"))).toBe(true);
      expect(existsSync(join(outside, "tilde.txt"))).toBe(true);
      expect(existsSync(join(outside, "url.txt"))).toBe(true);
      expect(existsSync(join(outside, "new.txt"))).toBe(true);
      expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
    });
  });
});

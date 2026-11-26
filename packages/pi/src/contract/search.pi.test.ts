import { type FauxContext, createTempDir } from "@atrium/testkit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScenario } from "../../test/contract";

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0014). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/** Atrium's two web tools (ADR-0014). */
const WEB_TOOLS = ["web_fetch", "web_search"] as const;

/**
 * The web tools a request offered the model, sorted.
 *
 * @remarks
 * pi's and the other parts' tools are left out.
 *
 * @sideEffects none
 * @param request - The request; none offered nothing.
 * @returns The offered web tool names.
 */
function webTools(request: FauxContext | undefined): string[] {
  return [...(request?.tools ?? [])].filter((tool) => (WEB_TOOLS as readonly string[]).includes(tool)).toSorted();
}

/**
 * The text of the last tool result a request carried.
 *
 * @remarks
 * Shows which extension answered the tool call.
 *
 * @sideEffects none
 * @param request - The request; none has no result.
 * @returns The tool result text.
 */
function lastResult(request: FauxContext | undefined): string {
  const result = (request?.messages ?? []).findLast(
    (message) => Reflect.get(message as object, "role") === "toolResult",
  );
  const content: unknown = result === undefined ? [] : Reflect.get(Object(result), "content");
  return Array.isArray(content)
    ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
    : "";
}

/**
 * Writes a small user extension that registers `names` at load time, as `pi-web-access` does.
 *
 * @remarks
 * Removed automatically when the test finishes.
 *
 * @sideEffects Creates a temporary directory with an `.mjs` extension file; deletes it on test end.
 * @param names - Tool names the extension registers at load time.
 * @returns The extension file's path.
 */
async function userWebExtension(names: readonly string[]): Promise<string> {
  const dir = await createTempDir("user-web-ext");
  onTestFinished(dir.cleanup);
  const file = join(dir.path, "user-web.mjs");
  const source = [
    "export default function (pi) {",
    `  for (const name of ${JSON.stringify(names)}) {`,
    "    pi.registerTool({",
    "      name,",
    "      label: name,",
    '      description: "User extension " + name,',
    '      parameters: { type: "object", properties: { query: { type: "string" } } },',
    '      async execute() { return { content: [{ type: "text", text: "from-user:" + name }], details: {} }; },',
    "    });",
    "  }",
    "}",
    "",
  ].join("\n");
  await writeFile(file, source);
  return file;
}

describe("pi contract: web tools (ADR-0014)", () => {
  it("yields web_search to a user extension loaded alongside Atrium while keeping web_fetch", async () => {
    const userExt = await userWebExtension(["web_search"]);
    await runScenario(
      {
        scenario: "search-yields-web-search",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION, userExt],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "atrium" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "search" });
        await until((event) => event.type === "agent_settled");
        const [first, second] = await contexts();

        expect(webTools(first)).toStrictEqual(["web_fetch", "web_search"]);
        expect(lastResult(second)).toBe("from-user:web_search");
      },
    );
  });

  it("registers web_search and web_fetch when no other extension provides them", async () => {
    await runScenario(
      {
        scenario: "search-registers-both",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        env: { DEEPSEEK_SEARCH_API_KEY: "" },
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "atrium" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "search" });
        await until((event) => event.type === "agent_settled");
        const [first, second] = await contexts();

        expect(webTools(first)).toStrictEqual(["web_fetch", "web_search"]);
        expect(lastResult(second)).toContain("DEEPSEEK_SEARCH_API_KEY");
      },
    );
  });

  it("respects --tools allowlists such as read-only sub-agents", async () => {
    await runScenario(
      {
        scenario: "search-respects-tools-allowlist",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: ["--tools", "read,grep,find,ls"],
        script: { replies: [{ blocks: [{ type: "text", text: "done" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "hello" });
        await until((event) => event.type === "agent_settled");
        const [first] = await contexts();

        expect(webTools(first)).toStrictEqual([]);
      },
    );
  });
});

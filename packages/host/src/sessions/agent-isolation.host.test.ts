import { createTempDir, present } from "@atrium/testkit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentRole } from "@atrium/protocol";
import { runScenario } from "../../../pi/test/contract";
import type { AgentRecord } from "../store/agent-records";
import { agentLaunchFlags } from "./agent-launch";

/** Atrium's extension, as the host has pi load it. */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../../../pi/src/extension/atrium.ts", import.meta.url));

/**
 * The catalog the host would hold: a main conversation and one child under it.
 *
 * @remarks
 * Only what the launch rules read; `by` is who opened the child, as the catalog records it.
 *
 * @sideEffects none
 * @param by - Who opened the child.
 * @param role - The role of the agent record on it.
 * @returns The entries.
 */
function catalog(by: "agent" | "user", role: AgentRole) {
  const record: AgentRecord = {
    handle: "child",
    role,
    toolGuard: "flags",
    startOn: null,
    worktree: false,
    tasks: [],
  };
  return [
    { sessionId: "main", containerId: "w1", parent: null, archived: false, agent: null },
    { sessionId: "child", containerId: "w1", parent: { sessionId: "main", by }, archived: false, agent: record },
  ];
}

/**
 * Starts real pi with Atrium's extension and the flags the host works out for the child, has a faux
 * model write a file inside and a file outside the working directory, and says which landed.
 *
 * @sideEffects Creates and removes temporary directories; starts pi, which writes in them.
 * @param by - Who opened the child.
 * @param role - Its role.
 * @returns Whether the inside file and the outside file exist afterwards.
 */
async function whatLands(by: "agent" | "user", role: AgentRole): Promise<{ inside: boolean; outside: boolean }> {
  const outside = await createTempDir("isolation-outside");
  onTestFinished(outside.cleanup);
  const target = join(outside.path, "outside.txt");
  let landed = { inside: false, outside: false };
  await runScenario(
    {
      scenario: "agent-isolation",
      unrecorded: true,
      extensions: [ATRIUM_EXTENSION],
      args: agentLaunchFlags(catalog(by, role), "child"),
      script: {
        replies: [
          {
            blocks: [
              { path: "./ok.txt", id: "call-1" },
              { path: target, id: "call-2" },
            ].map(({ path, id }) => ({
              type: "toolCall" as const,
              id,
              name: "write",
              arguments: { path: present(path, "path"), content: "written" },
            })),
          },
          { blocks: [{ type: "text" as const, text: "done" }] },
        ],
      },
    },
    async ({ pi, until, cwd }) => {
      await pi.request({ type: "prompt", message: "go" });
      await until((event) => event.type === "agent_settled");
      landed = { inside: existsSync(join(cwd, "ok.txt")), outside: existsSync(target) };
    },
  );
  return landed;
}

describe("path isolation of SPEC-0002's work children (host launch flags, real pi)", () => {
  it("blocks the outside write of a work child the agent opened, and keeps the inside one", async () => {
    expect(await whatLands("agent", "work")).toStrictEqual({ inside: true, outside: false });
  });

  it("blocks nothing in a work-role session the user opened", async () => {
    expect(await whatLands("user", "work")).toStrictEqual({ inside: true, outside: true });
  });
});

import { present } from "@atrium/testkit";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

/** Whether a file exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("pi contract: session files and entries", () => {
  it("session-lazy-file: the session file appears only once there is a message", async () => {
    await runScenario(
      {
        scenario: "session-lazy-file",
        session: true,
        script: { replies: [{ blocks: [{ type: "text", text: "saved" }] }] },
      },
      async ({ pi, until }) => {
        const before = (await pi.request({ type: "get_state" })) as { sessionFile?: string };
        const sessionFile = String(before.sessionFile);

        expect(await exists(sessionFile)).toBe(false);
        await pi.request({ type: "prompt", message: "hi" });
        await until((event) => event.type === "agent_settled");
        expect(await exists(sessionFile)).toBe(true);
      },
    );
  });

  it("get-entries: lists all entries with the leaf, then only newer ones after `since`, and rejects an unknown cursor", async () => {
    await runScenario(
      {
        scenario: "get-entries",
        session: true,
        script: {
          replies: [{ blocks: [{ type: "text", text: "first" }] }, { blocks: [{ type: "text", text: "second" }] }],
        },
      },
      async ({ pi, events, until }) => {
        await pi.request({ type: "prompt", message: "one" });
        await until((event) => event.type === "agent_settled");
        const all = await pi.request({ type: "get_entries" });
        await pi.request({ type: "prompt", message: "two" });
        await untilSettled(events, 2, until);
        const newer = await pi.request({ type: "get_entries", since: present(all.leafId, "leaf id") });
        const unknown = await pi.request({ type: "get_entries", since: "00000000" }).catch((error: unknown) => error);

        expect(all.entries.at(-1)?.id).toBe(all.leafId);
        expect(newer.entries.map((entry) => entry.id)).not.toContain(all.leafId);
        expect(newer.entries[0]?.parentId).toBe(all.leafId);
        expect(newer.entries.at(-1)?.id).toBe(newer.leafId);
        expect(unknown).toMatchObject({ reason: "rejected", detail: "Entry not found: 00000000" });
      },
    );
  });
});

/** Waits until `count` runs have settled. */
async function untilSettled(
  events: readonly { type: string }[],
  count: number,
  until: (predicate: (event: { type: string }) => boolean) => Promise<unknown>,
): Promise<void> {
  await until(() => events.filter((event) => event.type === "agent_settled").length >= count);
}

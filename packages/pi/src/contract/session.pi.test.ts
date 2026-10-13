import { present } from "@atrium/testkit";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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

  it("export-html: writes the page where told, only once there is a session file", async () => {
    await runScenario(
      {
        scenario: "export-html",
        session: true,
        script: { replies: [{ blocks: [{ type: "text", text: "exported" }] }] },
      },
      async ({ pi, cwd, until }) => {
        await mkdir(join(cwd, "out"));
        const outputPath = join(cwd, "out", "session.html");
        const early = await pi.request({ type: "export_html", outputPath }).catch((error: unknown) => error);
        await pi.request({ type: "prompt", message: "hi" });
        await until((event) => event.type === "agent_settled");
        const before = await readdir(cwd);

        expect(early).toMatchObject({
          reason: "rejected",
          detail: "Nothing to export yet - start a conversation first",
        });
        expect(await pi.request({ type: "export_html", outputPath })).toStrictEqual({ path: outputPath });
        expect(await readFile(outputPath, "utf8")).toMatch(/^<!DOCTYPE html>/i);
        expect(await readdir(cwd)).toStrictEqual(before);
      },
    );
  });

  it("fork-clone: fork copies the branch before a user message, clone the whole branch, each to a new file keeping entry ids", async () => {
    await runScenario(
      {
        scenario: "fork-clone",
        session: true,
        script: {
          replies: [{ blocks: [{ type: "text", text: "first" }] }, { blocks: [{ type: "text", text: "second" }] }],
        },
      },
      async ({ pi, events, until }) => {
        await pi.request({ type: "prompt", message: "one" });
        await until((event) => event.type === "agent_settled");
        await pi.request({ type: "prompt", message: "two" });
        await untilSettled(events, 2, until);
        const original = await pi.request({ type: "get_state" });
        const originalFile = present(original.sessionFile, "session file");
        const originalText = await readFile(originalFile, "utf8");
        const ids = (await pi.request({ type: "get_entries" })).entries.map((entry) => entry.id);
        const second = present(ids.at(-2), "the second user message");

        const forked = await pi.request({ type: "fork", entryId: second });
        const fork = await pi.request({ type: "get_state" });
        await pi.request({ type: "set_session_name", name: "fork" });
        const forkLines = await linesOf(present(fork.sessionFile, "fork file"));
        const cloned = await pi.request({ type: "clone" });
        const clone = await pi.request({ type: "get_state" });
        const cloneLines = await linesOf(present(clone.sessionFile, "clone file"));

        expect(forked).toStrictEqual({ text: "two", cancelled: false });
        expect(fork.sessionId).not.toBe(original.sessionId);
        expect(fork.sessionFile).not.toBe(originalFile);
        expect(forkLines[0]).toMatchObject({ type: "session", id: fork.sessionId, parentSession: originalFile });
        expect(forkLines.slice(1, -1).map((line) => line["id"])).toStrictEqual(ids.slice(0, -2));
        expect(forkLines.at(-1)).toMatchObject({ type: "session_info", name: "fork" });
        expect(cloned).toStrictEqual({ cancelled: false });
        expect(clone.sessionId).not.toBe(fork.sessionId);
        expect(cloneLines[0]).toMatchObject({ type: "session", id: clone.sessionId, parentSession: fork.sessionFile });
        expect(cloneLines.slice(1).map((line) => line["id"])).toStrictEqual(
          forkLines.slice(1).map((line) => line["id"]),
        );
        expect(await readFile(originalFile, "utf8")).toBe(originalText);
      },
    );
  });
});

/** A session file's lines, parsed. */
async function linesOf(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line): Record<string, unknown> => JSON.parse(line));
}

/** Waits until `count` runs have settled. */
async function untilSettled(
  events: readonly { type: string }[],
  count: number,
  until: (predicate: (event: { type: string }) => boolean) => Promise<unknown>,
): Promise<void> {
  await until(() => events.filter((event) => event.type === "agent_settled").length >= count);
}

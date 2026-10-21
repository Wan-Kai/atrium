import { present } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ScenarioContext, runScenario, startOtherPi } from "../../test/contract";
import { editCommand } from "../edit/edit";
import type { EditEntry } from "../edit/extension";
import type { PiEvent } from "../process/pi-process";

const EDIT = fileURLToPath(new URL("../edit/extension.ts", import.meta.url));
const CANCEL = fileURLToPath(new URL("./edit-cancel.ts", import.meta.url));
const IMAGE = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
} as const;
/** A valid session whose only message is a root user; no assistant or metadata hides the leaf no-op. */
const ROOT_SESSION =
  [
    {
      type: "session",
      version: 3,
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-10-20T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: "rootuser",
      parentId: null,
      timestamp: "2026-10-20T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "mistake" }, IMAGE], timestamp: 0 },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

/**
 * Reads pi's complete tree and selected leaf.
 * @remarks The host validates the real leaf instead of trusting a command's handled response.
 * @sideEffects Sends one RPC request.
 * @param pi - The scenario's running pi.
 * @returns Its entries and leaf.
 */
async function tree(pi: ScenarioContext["pi"]): Promise<{ entries: EditEntry[]; leafId: string | null }> {
  return await pi.request({ type: "get_entries" });
}

/**
 * Walks the actual branch, excluding entries retained only on sibling branches.
 * @remarks Reopening a session must select the newly persisted branch, not the old abandoned one.
 * @sideEffects none
 * @param entries - All tree entries.
 * @param leafId - Current leaf.
 * @returns The selected branch in chronological order.
 */
function branch(entries: readonly EditEntry[], leafId: string | null): EditEntry[] {
  const result: EditEntry[] = [];
  let id = leafId;
  while (id !== null) {
    const entry = present(
      entries.find((item) => item.id === id),
      "branch entry",
    );
    result.unshift(entry);
    id = entry.parentId;
  }
  return result;
}

/**
 * Reads the non-system messages seen by faux.
 * @remarks Old mistaken content and custom metadata must not leak into the replacement request.
 * @sideEffects none
 * @param messages - The model's context.
 * @returns Serializable non-system messages.
 */
function conversation(messages: readonly unknown[]): unknown[] {
  return messages.filter((message) => Reflect.get(Object(message), "role") !== "system");
}

/**
 * Recognizes the replacement reply, not the earlier aborted assistant.
 * @remarks A held faux reply was aborted before the replacement starts.
 * @sideEffects none
 * @param event - A real pi event.
 * @returns Whether it completes the replacement.
 */
function replacementEnded(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop";
}

/**
 * Names the role or metadata kind of a selected branch entry.
 * @remarks The root restoration asserts the whole selected branch, not just its leaf.
 * @sideEffects none
 * @param entry - The tree entry.
 * @returns A stable role or kind.
 */
function entryKind(entry: EditEntry): string {
  return entry.customType ?? entry.message?.role ?? entry.type;
}

describe("pi contract: stopped-message editing", () => {
  it("edit-aborted: rewinds an aborted assistant tail, excludes the old branch from context, keeps images and restarts on the replacement", async () => {
    await runScenario(
      {
        scenario: "edit-aborted",
        session: true,
        extensions: [EDIT],
        // Editing preserves original bytes; image conversion is pi's separate responsibility.
        settings: { images: { autoResize: false } },
        script: {
          replies: [
            { waitFor: "stop", blocks: [{ type: "text", text: "never" }] },
            { blocks: [{ type: "text", text: "replacement answer" }] },
          ],
        },
      },
      async ({ pi, until, heldAfterUserMessage, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "mistake", images: [IMAGE] });
        await heldAfterUserMessage(1);
        await pi.request({ type: "abort" });
        await until((event) => event.type === "agent_settled");
        const before = await tree(pi);
        const user = present(
          before.entries.find((entry) => entry.message?.role === "user"),
          "the user",
        );
        expect(before.entries.at(-1)).toMatchObject({
          type: "message",
          message: { role: "assistant", stopReason: "aborted" },
        });
        expect(
          await pi.request({
            type: "prompt",
            message: editCommand({ action: "rewind", token: "op-aborted", entryId: user.id, leafId: before.leafId }),
          }),
        ).toStrictEqual({ disposition: "handled" });
        const rewound = await tree(pi);
        expect(rewound.leafId).toBe(user.parentId);
        expect(rewound.entries.at(-1)).toMatchObject({
          type: "custom",
          customType: "atrium-edit-anchor",
          parentId: before.leafId,
        });
        await pi.request({ type: "prompt", message: "corrected", images: [IMAGE] });
        await until(replacementEnded);
        const after = await tree(pi);
        expect(after.entries.find((entry) => entry.id === user.id)).toMatchObject({
          message: { content: [{ type: "text", text: "mistake" }, IMAGE] },
        });
        expect(branch(after.entries, after.leafId).some((entry) => entry.id === user.id)).toBe(false);
        const request = present((await contexts()).at(-1), "replacement request");
        expect(conversation(request.messages)).toStrictEqual([
          expect.objectContaining({ role: "user", content: [{ type: "text", text: "corrected" }, IMAGE] }),
        ]);
        const file = present((await pi.request({ type: "get_state" })).sessionFile, "session file");
        await pi.stop();
        const restarted = await startOtherPi({
          dir: join(cwd, "restart"),
          args: ["--session", file],
          script: { replies: [] },
          extensions: [EDIT],
        });
        try {
          const reopened = await tree(restarted.pi);
          expect(reopened.leafId).toBe(after.leafId);
          expect(branch(reopened.entries, reopened.leafId)).toStrictEqual(branch(after.entries, after.leafId));
        } finally {
          await restarted.pi.stop();
        }
      },
    );
  });

  it("edit-root-restore: root user is the leaf, rewind reaches null, restore writes the original image branch and survives restart", async () => {
    await runScenario(
      {
        scenario: "edit-root-restore",
        session: true,
        extensions: [EDIT, CANCEL],
        files: { "sessions/root.jsonl": ROOT_SESSION },
        args: ["--session", "sessions/root.jsonl"],
        script: { replies: [] },
      },
      async ({ pi, cwd }) => {
        await pi.request({ type: "prompt", message: "/edit-root-leaf" });
        const before = await tree(pi);
        expect(before.leafId).toBe("rootuser");
        await pi.request({
          type: "prompt",
          message: editCommand({ action: "rewind", token: "op-root", entryId: "rootuser", leafId: before.leafId }),
        });
        const rewound = await tree(pi);
        expect(rewound.leafId).toBeNull();
        await pi.request({ type: "prompt", message: editCommand({ action: "restore", token: "op-root" }) });
        const after = await tree(pi);
        const selected = branch(after.entries, after.leafId);
        expect(selected.map(entryKind)).toStrictEqual(["user", "atrium-edit-anchor", "atrium-edit-restored"]);
        expect(selected[0]).toMatchObject({ message: { content: [{ type: "text", text: "mistake" }, IMAGE] } });
        const file = present((await pi.request({ type: "get_state" })).sessionFile, "session file");
        const disk = (await readFile(file, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as EditEntry);
        expect(disk.at(-1)?.id).toBe(after.leafId);
        await pi.stop();
        const restarted = await startOtherPi({
          dir: join(cwd, "restart"),
          args: ["--session", file],
          script: { replies: [] },
          extensions: [EDIT],
        });
        try {
          const reopened = await tree(restarted.pi);
          expect(
            branch(reopened.entries, reopened.leafId).filter((entry) => entry.type !== "thinking_level_change"),
          ).toStrictEqual(selected);
        } finally {
          await restarted.pi.stop();
        }
      },
    );
  });

  it("edit-image-only: replaces a root-user leaf with images and no text, without carrying the old branch into context", async () => {
    await runScenario(
      {
        scenario: "edit-image-only",
        session: true,
        extensions: [EDIT, CANCEL],
        files: { "sessions/root.jsonl": ROOT_SESSION },
        args: ["--session", "sessions/root.jsonl"],
        settings: { images: { autoResize: false } },
        script: { replies: [{ blocks: [{ type: "text", text: "image seen" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "/edit-root-leaf" });
        await pi.request({
          type: "prompt",
          message: editCommand({ action: "rewind", token: "image-only", entryId: "rootuser", leafId: "rootuser" }),
        });
        expect((await tree(pi)).leafId).toBeNull();
        expect(await pi.request({ type: "prompt", message: "", images: [IMAGE] })).toStrictEqual({
          disposition: "started",
        });
        await until(replacementEnded);
        const request = present((await contexts()).at(-1), "image-only request");
        expect(conversation(request.messages)).toStrictEqual([
          expect.objectContaining({ role: "user", content: [{ type: "text", text: "" }, IMAGE] }),
        ]);
        const after = await tree(pi);
        expect(after.entries.find((entry) => entry.id === "rootuser")).toMatchObject({
          message: { content: [{ type: "text", text: "mistake" }, IMAGE] },
        });
        expect(branch(after.entries, after.leafId).some((entry) => entry.id === "rootuser")).toBe(false);
      },
    );
  });

  it("edit-cancel: real navigation cancellation keeps the original branch and cancels restoration without persisting a success marker", async () => {
    await runScenario(
      {
        scenario: "edit-cancel",
        session: true,
        extensions: [EDIT, CANCEL],
        files: { "sessions/root.jsonl": ROOT_SESSION },
        args: ["--session", "sessions/root.jsonl"],
        script: { replies: [] },
      },
      async ({ pi }) => {
        await pi.request({ type: "prompt", message: "/edit-root-leaf" });
        await pi.request({ type: "prompt", message: "/edit-cancel-next" });
        expect(
          await pi.request({
            type: "prompt",
            message: editCommand({ action: "rewind", token: "cancelled", entryId: "rootuser", leafId: "rootuser" }),
          }),
        ).toStrictEqual({ disposition: "handled" });
        const cancelled = await tree(pi);
        const anchor = present(cancelled.entries.at(-1), "cancelled anchor");
        expect(cancelled.leafId).toBe(anchor.id);
        expect(anchor).toMatchObject({ type: "custom", parentId: "rootuser", customType: "atrium-edit-anchor" });
        await pi.request({
          type: "prompt",
          message: editCommand({
            action: "rewind",
            token: "restore-cancel",
            entryId: "rootuser",
            leafId: cancelled.leafId,
          }),
        });
        expect((await tree(pi)).leafId).toBeNull();
        await pi.request({ type: "prompt", message: "/edit-cancel-next" });
        expect(
          await pi.request({ type: "prompt", message: editCommand({ action: "restore", token: "restore-cancel" }) }),
        ).toStrictEqual({ disposition: "handled" });
        const restoreCancelled = await tree(pi);
        expect(restoreCancelled.leafId).toBeNull();
        expect(restoreCancelled.entries.some((entry) => entry.customType === "atrium-edit-restored")).toBe(false);
        await pi.request({ type: "prompt", message: editCommand({ action: "restore", token: "restore-cancel" }) });
        expect((await tree(pi)).entries.at(-1)?.customType).toBe("atrium-edit-restored");
      },
    );
  });

  it("edit-navigation-error: pi rejects navigation during streaming and retains the original user and anchor branch", async () => {
    await runScenario(
      {
        scenario: "edit-navigation-error",
        session: true,
        extensions: [EDIT],
        script: { replies: [{ waitFor: "stop", blocks: [{ type: "text", text: "never" }] }] },
      },
      async ({ pi, heldAfterUserMessage, until }) => {
        await pi.request({ type: "prompt", message: "mistake" });
        await heldAfterUserMessage(1);
        const before = await tree(pi);
        const user = present(
          before.entries.find((entry) => entry.message?.role === "user"),
          "user",
        );
        expect(
          await pi.request({
            type: "prompt",
            message: editCommand({ action: "rewind", token: "error", entryId: user.id, leafId: before.leafId }),
          }),
        ).toStrictEqual({ disposition: "handled" });
        const failed = await tree(pi);
        expect(failed.entries.at(-1)).toMatchObject({
          type: "custom",
          customType: "atrium-edit-anchor",
          parentId: user.id,
        });
        expect(branch(failed.entries, failed.leafId).some((entry) => entry.id === user.id)).toBe(true);
        await pi.request({ type: "abort" });
        await until((event) => event.type === "agent_settled");
      },
    );
  });
});

import { z } from "zod";
import { EDIT_COMMAND, readEditParams } from "./edit";

/**
 * A read-only session entry; no content is needed for tree edits.
 * pi's full union guarantees a message on message entries, and data only on custom entries.
 * Optional chaining and the corresponding type guards are defensive in this narrowed view;
 * removing them is equivalent on valid pi entries, not permission to accept malformed trees.
 */
export interface EditEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly message?: { readonly role: string };
  readonly customType?: string;
  readonly data?: unknown;
}

/** The read-only session surface and navigation command context used by editing. */
interface EditContext {
  readonly sessionManager: {
    getEntries(): readonly EditEntry[];
    getLeafId(): string | null;
    getEntry(id: string): EditEntry | undefined;
  };
  navigateTree(id: string, options: { readonly summarize: false }): Promise<{ readonly cancelled: boolean }>;
}

/** The narrow extension surface used by editing, checked against pi's real API in tests. */
export interface EditApi {
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: EditContext) => Promise<void>;
    },
  ): void;
  appendEntry(customType: string, data: unknown): void;
}

/** Custom entries are persisted metadata, unlike custom messages they never enter model context. */
const ANCHOR = "atrium-edit-anchor";
const RESTORED = "atrium-edit-restored";
const anchorSchema = z.strictObject({ token: z.string(), entryId: z.string(), fromLeaf: z.string().nullable() });
const restoredSchema = z.strictObject({ token: z.string() });

/**
 * Checks that a path reaches its expected base without forbidden entries or broken ancestry.
 * @remarks Restore permits metadata hooks but cannot overwrite any newly delivered model-context entry.
 * @sideEffects none
 * @param ctx - The session's read-only view.
 * @param leaf - The start of the path.
 * @param base - The required ancestor, possibly the root.
 * @param allowed - Whether each entry before the base may occur on the path.
 * @returns Whether the path is safe and complete.
 */
function pathTo(
  ctx: EditContext,
  leaf: string | null,
  base: string | null,
  allowed: (entry: EditEntry) => boolean,
): boolean {
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor !== base) {
    // The explicit null guard narrows pi's string-only getEntry API. Its runtime lookup would
    // also return undefined for null, caught below, so removing only this guard is equivalent.
    if (cursor === null || visited.has(cursor)) return false;
    visited.add(cursor);
    const entry = ctx.sessionManager.getEntry(cursor);
    if (entry === undefined || !allowed(entry)) return false;
    cursor = entry.parentId;
  }
  return true;
}

/**
 * Registers the host's guarded rewind and failure-restoration command.
 * @remarks The anchor defeats pi's user-leaf no-op and provides a non-user restore target;
 * navigating a user goes to its parent. The host must still read the actual leaf before sending
 * any replacement prompt: handled is not a successful rewind (SPEC-0001, stopped-message edit).
 * @sideEffects Registers a command; its handler appends metadata and changes the active branch.
 * @param pi - The extension API.
 */
export default function atriumEdit(pi: EditApi): void {
  pi.registerCommand(EDIT_COMMAND, {
    description: "Atrium's stopped-message edit, sent by Atrium's host",
    handler: async (args, ctx) => {
      const params = readEditParams(args);
      if (params === null) throw new Error("edit_invalid");
      const session = ctx.sessionManager;
      if (params.action === "rewind") {
        const target = session.getEntry(params.entryId);
        if (
          session.getLeafId() !== params.leafId ||
          target?.type !== "message" ||
          target.message?.role !== "user" ||
          !pathTo(ctx, params.leafId, target.id, () => true)
        )
          throw new Error("edit_conflict");
        pi.appendEntry(ANCHOR, { token: params.token, entryId: params.entryId, fromLeaf: params.leafId });
        const result = await ctx.navigateTree(target.id, { summarize: false });
        if (result.cancelled) throw new Error("edit_cancelled");
        return;
      }
      const entries = session.getEntries();
      const anchor = entries.findLast((entry) => entry.type === "custom" && entry.customType === ANCHOR);
      const parsed = anchorSchema.safeParse(anchor?.data);
      // safeParse(undefined) also rejects an absent anchor; the explicit guard narrows the
      // read-only entry for later navigation, so deleting only it is an equivalent mutant.
      if (
        anchor === undefined ||
        !parsed.success ||
        parsed.data.token !== params.token ||
        entries.some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === RESTORED &&
            restoredSchema.safeParse(entry.data).data?.token === params.token,
        )
      ) {
        throw new Error("edit_conflict");
      }
      const target = session.getEntry(parsed.data.entryId);
      if (
        target?.type !== "message" ||
        target.message?.role !== "user" ||
        anchor.parentId !== parsed.data.fromLeaf ||
        !pathTo(ctx, parsed.data.fromLeaf, target.id, () => true) ||
        !pathTo(
          ctx,
          session.getLeafId(),
          target.parentId,
          // A valid anchor also has the original user in its ancestry, already forbidden here;
          // excluding the anchor explicitly is defense in depth (an equivalent mutant).
          (entry) => entry.type !== "message" && entry.type !== "custom_message" && entry.id !== anchor.id,
        )
      ) {
        throw new Error("edit_conflict");
      }
      const result = await ctx.navigateTree(anchor.id, { summarize: false });
      if (result.cancelled) throw new Error("edit_cancelled");
      if (session.getLeafId() !== anchor.id) throw new Error("edit_conflict");
      // Navigation alone is in memory: a custom entry makes the selected branch survive restart.
      pi.appendEntry(RESTORED, { token: params.token });
    },
  });
}

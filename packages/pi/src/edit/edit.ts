import { z } from "zod";

/** The host-only tree-edit command, checked in pi's command catalog before it is sent. */
export const EDIT_COMMAND = "atrium-edit";
/** Maximum encoded argument length; these commands carry ids, never conversation content. */
const ARGUMENT_LIMIT = 1024;
/** Bounded opaque ids also exclude whitespace and command separators. */
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const paramsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("rewind"), token: id, entryId: id, leafId: id.nullable() }),
  z.strictObject({ action: z.literal("restore"), token: id }),
]);

/** A host operation identifying a branch, without user text or images. */
export type EditParams = z.infer<typeof paramsSchema>;

/**
 * Encodes a bounded host-only edit command.
 * @remarks Strict objects prevent conversation content from leaking into hidden command arguments.
 * @sideEffects none
 * @param params - The operation and its opaque ids.
 * @returns The slash command to send to pi.
 * @throws When parameters do not match the host boundary.
 */
export function editCommand(params: EditParams): string {
  return `/${EDIT_COMMAND} ${Buffer.from(JSON.stringify(paramsSchema.parse(params))).toString("base64url")}`;
}

/**
 * Decodes a strict id-only command argument.
 * @remarks Buffer's decoder is permissive, so spelling and canonical encoding are checked too.
 * @sideEffects none
 * @param args - The encoded JSON, with no command prefix.
 * @returns The operation, or null for invalid input.
 */
export function readEditParams(args: string): EditParams | null {
  if (args.length > ARGUMENT_LIMIT) return null;
  try {
    const decoded = Buffer.from(args, "base64url");
    if (decoded.toString("base64url") !== args) return null;
    const parsed = paramsSchema.safeParse(JSON.parse(decoded.toString("utf8")) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    // Malformed JSON is an expected command-boundary rejection, not a navigation failure.
    return null;
  }
}

import { z } from "zod";
import { DirectionId, SessionId } from "./ids";

/** The longest message a visual may send, in characters (SPEC-0007, "回传"). */
export const VISUAL_MESSAGE_MAX = 4000;

/** The largest visual file the host serves, in bytes (SPEC-0007, "一个演示 = 一个文件"). */
export const VISUAL_FILE_MAX = 1024 * 1024;

/**
 * A visual's path as a reply names it: relative to the session's working directory, or absolute
 * inside the directory the host gives for visuals.
 */
export const VisualPath = z.string().min(1).max(4096);
export type VisualPath = z.infer<typeof VisualPath>;

/** Where a user message came from when it was not typed: a visual's answer (SPEC-0007, "回传"). */
export const VisualSource = z.strictObject({ kind: z.literal("visual"), path: VisualPath });
export type VisualSource = z.infer<typeof VisualSource>;

/**
 * Whether exactly one of a session and a direction is named.
 *
 * @remarks
 * A visual is resolved for a session's reply or for a direction's viewer tab, never both
 * (SPEC-0008, "ML4 定的细节 · 协议"); zod has no exclusive fields of its own.
 *
 * @sideEffects none
 * @param value - The command or event.
 * @returns Whether it names one.
 */
export function namesOneOwner(value: { readonly sessionId?: unknown; readonly directionId?: unknown }): boolean {
  return (value.sessionId === undefined) !== (value.directionId === undefined);
}

/**
 * A visual file a connection resolved has changed; its cards load it again.
 *
 * @remarks
 * It names what it was resolved for: a session, or a direction for its viewer tabs (ML4).
 */
export const VisualChangedEvent = z
  .strictObject({
    type: z.literal("visual_changed"),
    sessionId: SessionId.optional(),
    directionId: DirectionId.optional(),
    path: VisualPath,
    mtime: z.number().int().nonnegative(),
  })
  // No message of its own: a failure only ever becomes `invalid_message`.
  .refine(namesOneOwner);
export type VisualChangedEvent = z.infer<typeof VisualChangedEvent>;

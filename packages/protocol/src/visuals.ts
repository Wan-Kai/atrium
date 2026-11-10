import { z } from "zod";
import { SessionId } from "./ids";

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

/** A visual file a connection resolved has changed; its cards load it again. */
export const VisualChangedEvent = z.strictObject({
  type: z.literal("visual_changed"),
  sessionId: SessionId,
  path: VisualPath,
  mtime: z.number().int().nonnegative(),
});
export type VisualChangedEvent = z.infer<typeof VisualChangedEvent>;

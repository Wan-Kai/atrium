import { z } from "zod";

/** The longest command name and description the protocol carries. */
export const SLASH_COMMAND_LIMITS = { name: 256, description: 4096 } as const;

/**
 * A command `/` lists: an extension command, a prompt template or a skill (pi-internals.md §3).
 *
 * @remarks
 * Skills are named `skill:<name>`, as pi names them. pi's built-in terminal commands do not exist
 * in RPC and are never listed (SPEC-0001, "模型与输入框").
 */
export const SlashCommand = z.strictObject({
  name: z.string().min(1).max(SLASH_COMMAND_LIMITS.name),
  description: z.string().max(SLASH_COMMAND_LIMITS.description).nullable(),
  source: z.enum(["extension", "prompt", "skill"]),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

/** A file or directory `@` offers, relative to the session's directory; a directory ends in `/`. */
export const FileCandidate = z.strictObject({
  path: z.string().min(1).max(4096),
  directory: z.boolean(),
});
export type FileCandidate = z.infer<typeof FileCandidate>;

import { z } from "zod";

/** The ordinary configuration files the settings editor may access; never credential files. */
export const PiConfigName = z.enum(["settings.json", "models.json", "mcp.json", "keybindings.json"]);
export type PiConfigName = z.infer<typeof PiConfigName>;

/** Only these ordinary configuration files have a project-level pi counterpart. */
export const PI_PROJECT_CONFIG_NAMES: readonly PiConfigName[] = ["settings.json", "mcp.json"];

/** Maximum configuration size; the host additionally enforces this in UTF-8 bytes. */
export const PI_CONFIG_MAX_BYTES = 256 * 1024;

/** A digest of the exact file bytes, or `null` when the file has not been created. */
export const PiConfigRevision = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();

/** A configuration's actual host path, unchanged text and optimistic save version. */
export const PiConfigFile = z.strictObject({
  path: z.string().min(1).max(4096),
  text: z.string().max(PI_CONFIG_MAX_BYTES),
  revision: PiConfigRevision,
});
export type PiConfigFile = z.infer<typeof PiConfigFile>;

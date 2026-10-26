import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { errorCode } from "./errors";

/** The relay's hand-written configuration, `<dir>/relay.json` (SPEC-0005, "部署 relay"). */
export interface RelayConfig {
  /** The public host name, with a port if not 443, as it goes into the `atrium-relay://` line. */
  readonly publicHost: string;
  /** Where the relay's paths start, such as `/atrium`; empty for the root. */
  readonly pathPrefix: string;
  /** Proxies whose `X-Forwarded-For` / `X-Real-IP` are believed, exact addresses. */
  readonly trustedProxies: readonly string[];
  /** New streams one address may open per minute; 0 turns the limit off. */
  readonly newStreamsPerIpPerMinute: number;
}

const configSchema = z.strictObject({
  publicHost: z.string().regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/),
  pathPrefix: z
    .string()
    .regex(/^(?:\/[A-Za-z0-9._~-]+)*$/)
    .default(""),
  trustedProxies: z
    .array(z.string().refine((address) => isIP(address) !== 0))
    .max(64)
    .default([]),
  newStreamsPerIpPerMinute: z.number().int().min(0).max(100_000).default(30),
});

/** Why `relay.json` could not be used. */
export type ConfigError =
  | { readonly code: "config_missing" }
  | { readonly code: "config_invalid"; readonly fields: string[] };

/**
 * Reads and checks `<dir>/relay.json`.
 *
 * @remarks
 * Unknown fields are an error so a misspelt setting does not silently keep its default (SPEC-0005,
 * "部署 relay"). The path prefix decides every route and goes into the line `add-host` prints, so
 * there is no default configuration: a relay started without one would answer on the wrong
 * paths. Only the names of bad fields are reported, never their values.
 *
 * @sideEffects Reads the file.
 * @param dir - The data directory.
 * @returns The configuration, or why not.
 * @throws When the file exists but cannot be read for another reason than not existing.
 */
export async function loadConfig(
  dir: string,
): Promise<{ ok: true; config: RelayConfig } | { ok: false; error: ConfigError }> {
  let text: string;
  try {
    text = await readFile(join(dir, "relay.json"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, error: { code: "config_missing" } };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "config_invalid", fields: [] } };
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys.join(",") : issue.path.join("."),
    );
    return { ok: false, error: { code: "config_invalid", fields } };
  }
  return { ok: true, config: parsed.data };
}

/**
 * The one line a host is given: `atrium-relay://<hostId>:<token>@<publicHost><pathPrefix>`.
 *
 * @remarks
 * The desktop's "手机" page takes this line and connects to `wss://<publicHost><pathPrefix>/v1/host`
 * (SPEC-0005, "部署 relay" item 5). The token is base64url and the host id hex, so neither needs
 * escaping in the user part.
 *
 * @sideEffects none
 * @param config - The relay's configuration.
 * @param hostId - The host.
 * @param token - Its token, which the line is the only place to show.
 * @returns The line.
 */
export function relayLine(config: RelayConfig, hostId: string, token: string): string {
  return `atrium-relay://${hostId}:${token}@${config.publicHost}${config.pathPrefix}`;
}

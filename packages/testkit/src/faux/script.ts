import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A JSON value, as tool call arguments must be. */
type FauxJson = null | boolean | number | string | readonly FauxJson[] | { readonly [key: string]: FauxJson };

/** One content block of a scripted reply. */
export type FauxBlock =
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "toolCall";
      /** Fixed id, so recorded output is the same on every run. */
      readonly id: string;
      readonly name: string;
      readonly arguments: { readonly [key: string]: FauxJson };
    };

/** One model reply; a reply with `error` ends with `stopReason: "error"`. */
export interface FauxReply {
  readonly blocks: readonly FauxBlock[];
  readonly error?: string;
}

/** Everything the faux model will say, in order, for one pi process. */
export interface FauxScript {
  /** Slows streaming down to this pace, so a test can interrupt a reply mid-stream. */
  readonly tokensPerSecond?: number;
  readonly replies: readonly FauxReply[];
}

/** Provider name the faux extension registers. */
export const FAUX_PROVIDER = "faux";
/** Model id the faux extension registers. */
export const FAUX_MODEL = "faux-1";
/** Fixed API name; faux would otherwise generate one with a timestamp in it. */
export const FAUX_API = "atrium-faux";
/** Environment variable that tells the extension where the script is. */
export const FAUX_SCRIPT_ENV = "ATRIUM_FAUX_SCRIPT";

/** How to start a pi process that answers with the faux model. */
export interface FauxPiLaunch {
  /** Arguments to add after `--mode rpc`. */
  readonly args: readonly string[];
  /** Variables to add to the child's environment (the caller still provides PATH). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Writes a reply script and returns the arguments and environment that make pi use it.
 *
 * @remarks
 * pi contract tests, host integration tests and end-to-end tests all start pi through this one
 * function, so they run pi the same way (testing.md, "faux 模型"). `PI_CODING_AGENT_DIR` points
 * at an empty directory under `dir`, so the user's `~/.pi/agent` settings, extensions and
 * credentials never reach the test.
 *
 * @sideEffects Creates `dir/pi-agent` and writes `dir/faux-script.json`.
 * @param script - Replies the faux model gives, in order.
 * @param dir - A temporary directory owned by the test.
 * @returns Arguments and environment variables for the pi process.
 */
export async function fauxPi(script: FauxScript, dir: string): Promise<FauxPiLaunch> {
  const agentDir = join(dir, "pi-agent");
  const scriptPath = join(dir, "faux-script.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script));
  return {
    args: [
      "--extension",
      fileURLToPath(new URL("extension.ts", import.meta.url)),
      "--provider",
      FAUX_PROVIDER,
      "--model",
      FAUX_MODEL,
    ],
    env: { PI_CODING_AGENT_DIR: agentDir, [FAUX_SCRIPT_ENV]: scriptPath },
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  /**
   * Hold the reply until the test calls `release(name)`; pi prints nothing meanwhile, so whatever
   * the test sends in between lands at a fixed place in the recorded fixture. An abort ends the wait.
   */
  readonly waitFor?: string;
}

/** A model the faux provider offers besides `FAUX_MODEL`, which is always first. */
interface FauxModel {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  /** pi's per-model thinking map: `null` drops a level; `xhigh` and `max` exist only when named. */
  readonly thinkingLevelMap?: Readonly<
    Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>
  >;
}

/** Everything the faux model will say, in order, for one pi process. */
export interface FauxScript {
  /** Slows streaming down to this pace, so a test can interrupt a reply mid-stream. */
  readonly tokensPerSecond?: number;
  readonly replies: readonly FauxReply[];
  /**
   * What pi answers in print mode (`-p`), as when the host asks for a session's title; without it,
   * an error, so the title stays the fallback.
   */
  readonly title?: string;
  /** More models after `FAUX_MODEL`, for switching models. */
  readonly models?: readonly FauxModel[];
}

/** Provider name the faux extension registers. */
export const FAUX_PROVIDER = "faux";
/** Model id the faux extension registers. */
export const FAUX_MODEL = "faux-1";
/** Fixed API name; faux would otherwise generate one with a timestamp in it. */
export const FAUX_API = "atrium-faux";
/** Environment variable naming the directory where released gates appear as files. */
export const FAUX_GATES_ENV = "FAUX_PI_GATES";
/** The file beside the gates where the faux extension writes the process id of the pi running it. */
export const FAUX_PID_FILE = "pi.pid";
/** Environment variable that tells the extension where the script is; not `ATRIUM_*`, which the host keeps from pi. */
export const FAUX_SCRIPT_ENV = "FAUX_PI_SCRIPT";

/** How to start a pi process that answers with the faux model. */
export interface FauxPiLaunch {
  /** Arguments to add after `--mode rpc`. */
  readonly args: readonly string[];
  /** Variables to add to the child's environment (the caller still provides PATH). */
  readonly env: Readonly<Record<string, string>>;
  /** pi's agent directory, where it keeps its settings and session files. */
  readonly agentDir: string;
  /** Lets replies scripted with `waitFor: name` continue. */
  release(name: string): Promise<void>;
  /** The process id of the pi that loaded the extension last. */
  pid(): Promise<number>;
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
 * @sideEffects Creates `dir/pi-agent` and `dir/faux-gates`, and writes `dir/faux-script.json`;
 * `release` writes a file into `dir/faux-gates`; `pid` reads `dir/pi.pid`.
 * @param script - Replies the faux model gives, in order.
 * @param dir - A temporary directory owned by the test.
 * @returns Arguments and environment variables for the pi process.
 */
export async function fauxPi(script: FauxScript, dir: string): Promise<FauxPiLaunch> {
  const agentDir = join(dir, "pi-agent");
  const gatesDir = join(dir, "faux-gates");
  const scriptPath = join(dir, "faux-script.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(gatesDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script));
  return {
    release: (name) => writeFile(join(gatesDir, name), ""),
    pid: async () => Number(await readFile(join(dir, FAUX_PID_FILE), "utf8")),
    agentDir,
    args: [
      "--extension",
      fileURLToPath(new URL("extension.ts", import.meta.url)),
      "--provider",
      FAUX_PROVIDER,
      "--model",
      FAUX_MODEL,
    ],
    env: { PI_CODING_AGENT_DIR: agentDir, [FAUX_SCRIPT_ENV]: scriptPath, [FAUX_GATES_ENV]: gatesDir },
  };
}

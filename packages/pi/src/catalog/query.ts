import type { CatalogModel, ModelRef } from "@atrium/protocol";
import type { PiDeps } from "../deps";
import { CODEX, FAST_COMMAND, FAST_STATUS, type FastReport, type FastTiers, readFastReport } from "../fast/fast";
import { type PiLaunch, type PiProcess, PiRequestError, startPiProcess } from "../process/pi-process";
import { isFastSwitch } from "./commands";
import { sessionModelOf, toCatalogModel } from "./models";

/** The models pi can use in a directory, and the one it picks by its own settings. */
export interface ModelList {
  readonly models: readonly CatalogModel[];
  readonly defaultModel: ModelRef | null;
}

/** How long the Fast extension gets to report Codex's model list (SPEC-0001, "Fast"). */
const FAST_TIERS_WAIT_MS = 20_000;

/**
 * Asks the Fast extension in a short-lived pi for Codex's model list.
 *
 * @remarks
 * Only when pi lists Atrium's switch, or pi would pass the words to the model (SPEC-0001, "Fast").
 * `/atrium-fast tiers` asks Codex and reports as the status `atrium-fast` before pi answers the
 * prompt (pi-internals.md §5). A report that does not fit, a failure, or a prompt pi does not
 * answer in time or refuses leaves the built-in rule rather than failing the list, and is logged
 * by its code alone.
 *
 * @sideEffects Sends pi two commands; logs a failure.
 * @param pi - The running pi.
 * @param deps - Host infrastructure.
 * @param signal - Aborts the query.
 * @param waitMs - How long the extension gets.
 * @returns Codex's model list, or `null` for the built-in rule.
 * @throws {PiRequestError} When pi refuses to list its commands, or the query is aborted.
 */
async function queryFastTiers(
  pi: PiProcess,
  deps: PiDeps,
  signal: AbortSignal,
  waitMs: number,
): Promise<FastTiers | null> {
  const { commands } = await pi.request({ type: "get_commands" }, { timeoutMs: null, signal });
  if (!commands.some(isFastSwitch)) return null;
  const seen: { report: FastReport | null } = { report: null };
  const unsubscribe = pi.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === FAST_STATUS) {
      seen.report = readFastReport(event.statusText);
    }
  });
  let unanswered: string | null = null;
  try {
    await pi.request({ type: "prompt", message: `/${FAST_COMMAND} tiers` }, { timeoutMs: waitMs, signal });
  } catch (error) {
    if (signal.aborted || !(error instanceof PiRequestError)) throw error;
    unanswered = `pi_${error.reason}`;
  } finally {
    unsubscribe();
  }
  const { report: reported } = seen;
  if (reported !== null && "models" in reported) return new Map(reported.models.map(({ id, fast }) => [id, fast]));
  deps.log.warn({ failure: reported?.failure ?? unanswered ?? "no_report" }, "fast tiers unavailable");
  return null;
}

/** What else a model query does. */
export interface QueryOptions {
  /** Atrium's Fast extension, for pi to load and ask for Codex's model list; none goes by the built-in rule. */
  readonly fastExtension?: string;
  /** How long the extension gets to report, {@link FAST_TIERS_WAIT_MS} by default; tests shorten it. */
  readonly fastTiersWaitMs?: number;
}

/**
 * Asks a short-lived pi which models it can use in a directory.
 *
 * @remarks
 * As Paseo does (paseo-architecture.md §3, SPEC-0001 "模型与输入框"): pi without a session in the
 * directory answers `get_available_models` (only providers with credentials) and `get_state`,
 * whose model is the one pi picks by its own settings; then it stops. `get_available_models` is
 * the only machine-readable list (pi-internals.md §4). Without any credentials pi lists nothing and
 * reports a placeholder model; the default must be a model it lists. A pi that exits fails the
 * request with the end of its stderr as `detail`. The caller sets the deadline through `signal`.
 *
 * With the Fast extension, pi loads it and, when it lists any of ChatGPT's models, is asked for
 * Codex's model list, which decides what Fast does for each (ADR-0008, point 6).
 *
 * @sideEffects Runs pi until it has answered, failed or been aborted.
 * @param launch - pi's path, its environment and the directory; `--no-session` is added.
 * @param deps - Host infrastructure.
 * @param signal - Aborts the query and stops pi.
 * @param options - The Fast extension, if any.
 * @returns The list.
 * @throws {PiRequestError} When pi exits, refuses, or the query is aborted.
 */
export async function queryModels(
  launch: PiLaunch,
  deps: PiDeps,
  signal: AbortSignal,
  options: QueryOptions = {},
): Promise<ModelList> {
  if (signal.aborted) throw new PiRequestError("get_available_models", "aborted");
  const { fastExtension, fastTiersWaitMs = FAST_TIERS_WAIT_MS } = options;
  const extension = fastExtension === undefined ? [] : ["--extension", fastExtension];
  const pi = startPiProcess({ ...launch, args: [...launch.args, ...extension, "--no-session"] }, deps);
  try {
    // No deadline of pi's own: the caller's signal is the deadline.
    const { models } = await pi.request({ type: "get_available_models" }, { timeoutMs: null, signal });
    const state = await pi.request({ type: "get_state" }, { timeoutMs: null, signal });
    const chosen = sessionModelOf(state);
    const tiers =
      fastExtension !== undefined && models.some((model) => model.provider === CODEX)
        ? await queryFastTiers(pi, deps, signal, fastTiersWaitMs)
        : null;
    const catalog = models.flatMap((model) => toCatalogModel(model, tiers) ?? []);
    const listed =
      chosen !== null &&
      catalog.some((model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId);
    return {
      models: catalog,
      defaultModel: listed ? { providerId: chosen.providerId, modelId: chosen.modelId } : null,
    };
  } finally {
    await pi.stop();
  }
}

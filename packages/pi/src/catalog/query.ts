import type { CatalogModel, ModelRef } from "@atrium/protocol";
import type { PiDeps } from "../deps";
import { type PiLaunch, PiRequestError, startPiProcess } from "../process/pi-process";
import { sessionModelOf, toCatalogModel } from "./models";

/** The models pi can use in a directory, and the one it picks by its own settings. */
export interface ModelList {
  readonly models: readonly CatalogModel[];
  readonly defaultModel: ModelRef | null;
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
 * @sideEffects Runs pi until it has answered, failed or been aborted.
 * @param launch - pi's path, its environment and the directory; `--no-session` is added.
 * @param deps - Host infrastructure.
 * @param signal - Aborts the query and stops pi.
 * @returns The list.
 * @throws {PiRequestError} When pi exits, refuses, or the query is aborted.
 */
export async function queryModels(launch: PiLaunch, deps: PiDeps, signal: AbortSignal): Promise<ModelList> {
  if (signal.aborted) throw new PiRequestError("get_available_models", "aborted");
  const pi = startPiProcess({ ...launch, args: [...launch.args, "--no-session"] }, deps);
  try {
    // No deadline of pi's own: the caller's signal is the deadline.
    const { models } = await pi.request({ type: "get_available_models" }, { timeoutMs: null, signal });
    const state = await pi.request({ type: "get_state" }, { timeoutMs: null, signal });
    const chosen = sessionModelOf(state);
    const catalog = models.flatMap((model) => toCatalogModel(model) ?? []);
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

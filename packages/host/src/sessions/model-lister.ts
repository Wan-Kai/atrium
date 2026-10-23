import { type ModelCatalog, PiRequestError } from "@atrium/pi";
import { CommandError, type CommandResult } from "@atrium/protocol";
import { stat } from "node:fs/promises";

/** How much of pi's own text a failure carries to the UI. */
const DETAIL_LIMIT = 4096;

/**
 * Creates the `list_models` command over the model catalog.
 *
 * @remarks
 * A workspace's models are pi's in its directory; those outside any workspace, every chat's and the
 * settings', are pi's in Atrium's home, under which each chat's own empty directory lies, with only
 * the global settings (SPEC-0001, "模型与输入框"). A directory that is gone, as a worktree deleted
 * outside Atrium, gets `path_not_found` before any pi or cached list: pi could not start there, and
 * its failing start would read as a crash in the log. pi failing to answer becomes
 * `models_unavailable` with the end of what pi said, for "展开看原始报错"; it goes only to the UI,
 * never into the log, as it may carry secrets (security.md, "凭据与日志").
 *
 * @sideEffects Looks at the directory.
 * @param options - The catalog, where each workspace is, and the directory outside any.
 * @returns The command.
 */
export function createModelLister(options: {
  readonly catalog: Pick<ModelCatalog, "list">;
  readonly dirOf: (workspaceId: string) => string | undefined;
  readonly chatsDir: string;
}): (workspaceId: string | null, refresh: boolean) => Promise<CommandResult<"list_models">> {
  return async (workspaceId, refresh) => {
    const dir = workspaceId === null ? options.chatsDir : options.dirOf(workspaceId);
    if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId });
    const directory = await stat(dir).catch(() => null);
    if (directory?.isDirectory() !== true) throw new CommandError("path_not_found", { path: dir });
    try {
      const { models, defaultModel } = await options.catalog.list(dir, refresh);
      return { models: [...models], defaultModel };
    } catch (error) {
      if (!(error instanceof PiRequestError)) throw error;
      throw new CommandError("models_unavailable", { detail: (error.detail ?? "").slice(-DETAIL_LIMIT) });
    }
  };
}

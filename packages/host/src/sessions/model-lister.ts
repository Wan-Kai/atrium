import { type ModelCatalog, PiRequestError } from "@atrium/pi";
import { CHATS, CommandError, type CommandResult, type ContainerId } from "@atrium/protocol";

/** How much of pi's own text a failure carries to the UI. */
const DETAIL_LIMIT = 4096;

/**
 * Creates the `list_models` command over the model catalog.
 *
 * @remarks
 * A workspace's models are pi's in its directory; the chats' are pi's in Atrium's home, under which
 * each chat's own empty directory lies, with only the global settings (SPEC-0001, "模型与输入框"). pi failing to answer becomes `models_unavailable` with the end of what pi said,
 * for "展开看原始报错"; it goes only to the UI, never into the log, as it may carry secrets
 * (security.md, "凭据与日志").
 *
 * @sideEffects none
 * @param options - The catalog, where each workspace is, and the directory for the chats.
 * @returns The command.
 */
export function createModelLister(options: {
  readonly catalog: Pick<ModelCatalog, "list">;
  readonly dirOf: (workspaceId: string) => string | undefined;
  readonly chatsDir: string;
}): (containerId: ContainerId, refresh: boolean) => Promise<CommandResult<"list_models">> {
  return async (containerId, refresh) => {
    const dir = containerId === CHATS ? options.chatsDir : options.dirOf(containerId);
    if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId: containerId });
    try {
      const { models, defaultModel } = await options.catalog.list(dir, refresh);
      return { models: [...models], defaultModel };
    } catch (error) {
      if (!(error instanceof PiRequestError)) throw error;
      throw new CommandError("models_unavailable", { detail: (error.detail ?? "").slice(-DETAIL_LIMIT) });
    }
  };
}

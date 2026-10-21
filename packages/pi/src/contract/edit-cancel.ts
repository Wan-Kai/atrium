import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Installs a one-shot tree-navigation cancellation probe for real-pi edit contracts.
 * @remarks A real session_before_tree hook proves cancellation retains the anchor branch.
 * @sideEffects Registers a command and a session hook; keeps the next cancellation flag in memory.
 * @param pi - pi's extension API.
 */
export default function editCancel(pi: ExtensionAPI): void {
  let cancel = false;
  pi.registerCommand("edit-root-leaf", {
    description: "Sets up the rare root-user leaf for edit contracts",
    handler: (_args, ctx) => {
      // Setup only: pi adds missing settings metadata on startup. The production extension
      // never reaches behind the read-only session view or calls branch directly.
      const manager = ctx.sessionManager;
      if (!("branch" in manager) || typeof manager.branch !== "function") throw new Error("missing setup API");
      manager.branch("rootuser");
      return Promise.resolve();
    },
  });
  pi.registerCommand("edit-cancel-next", {
    description: "Cancels the next tree navigation in edit contract tests",
    handler: () => {
      cancel = true;
      return Promise.resolve();
    },
  });
  pi.on("session_before_tree", () => {
    if (!cancel) return undefined;
    cancel = false;
    return { cancel: true };
  });
}

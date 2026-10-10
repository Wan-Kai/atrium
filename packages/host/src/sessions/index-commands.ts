import type { CommandResult, ContainerId, Preferences } from "@atrium/protocol";
import type { ProjectService } from "../projects/project-service";
import type { PreferenceStore } from "../store/preferences";
import type { IndexCursor, IndexFeed } from "../sync/index-feed";
import type { WorkspaceService } from "../workspaces/workspace-service";
import type { SessionManager } from "./session-manager";

/** The list commands the server hands on: projects, workspaces and preferences. */
export interface IndexCommands {
  subscribeIndex(connectionId: string, cursor?: IndexCursor): Promise<CommandResult<"subscribe_index">>;
  addProject(path: string): Promise<CommandResult<"add_project">>;
  removeProject(projectId: string): Promise<CommandResult<"remove_project">>;
  renameProject(projectId: string, name: string): Promise<CommandResult<"rename_project">>;
  renameWorkspace(workspaceId: string, name: string | null): Promise<CommandResult<"rename_workspace">>;
  windowFocused(): Promise<CommandResult<"window_focused">>;
  setPreferences(changes: Partial<Preferences>): Promise<CommandResult<"set_preferences">>;
  /** The models pi can use in a container's directory; `refresh` asks pi again. */
  listModels(containerId: ContainerId, refresh: boolean): Promise<CommandResult<"list_models">>;
  /** A command of the connection is about to be answered; the list changes waiting go to it first. */
  answering(connectionId: string): void;
}

/**
 * Creates the list commands.
 *
 * @remarks
 * Defined beside the session layer, which removing a project also reaches: the project's
 * sessions stop and leave every layout (SPEC-0001, "项目、工作区与会话"). Changes reach clients
 * through the services' own change listeners, except preferences, which tell the feed here.
 * Failures are thrown as `CommandError` by the services.
 *
 * @sideEffects none until a command arrives.
 * @param options - The services, the feed and the model lister.
 * @returns The commands.
 */
export function createIndexCommands(options: {
  readonly projects: ProjectService;
  readonly workspaces: Pick<WorkspaceService, "windowFocused">;
  readonly sessions: Pick<SessionManager, "forgetWorkspaces" | "rescan">;
  readonly preferences: PreferenceStore;
  readonly feed: IndexFeed;
  /** Lists a container's models (`createModelLister`). */
  readonly listModels: IndexCommands["listModels"];
}): IndexCommands {
  return {
    async subscribeIndex(connectionId, cursor) {
      options.feed.subscribe(connectionId, cursor);
      return {};
    },
    async addProject(path) {
      return { projectId: await options.projects.add(path) };
    },
    async removeProject(projectId) {
      // The sessions are found through the project's workspaces, so they stop before it goes.
      const workspaceIds = options.projects
        .workspaces()
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.id);
      if (options.projects.projects().some((project) => project.id === projectId)) {
        await options.sessions.forgetWorkspaces(workspaceIds);
      }
      await options.projects.remove(projectId);
      return {};
    },
    async renameProject(projectId, name) {
      await options.projects.rename(projectId, name);
      return {};
    },
    async renameWorkspace(workspaceId, name) {
      await options.projects.renameWorkspace(workspaceId, name);
      return {};
    },
    async windowFocused() {
      options.workspaces.windowFocused();
      options.sessions.rescan();
      return {};
    },
    answering(connectionId) {
      options.feed.flush(connectionId);
    },
    async setPreferences(changes) {
      await options.preferences.set(changes);
      options.feed.changed();
      return {};
    },
    listModels: (containerId, refresh) => options.listModels(containerId, refresh),
  };
}

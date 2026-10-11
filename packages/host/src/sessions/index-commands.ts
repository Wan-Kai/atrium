import type { CommandResult, ContainerId, DiscoveredDirectory, Preferences } from "@atrium/protocol";
import { checkProxy } from "../platform/proxy";
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
  /** The working directories of pi's past sessions that could become projects. */
  discoverProjects(): Promise<CommandResult<"discover_projects">>;
  /** The branches on a project's `origin`, and the one `origin/HEAD` points at. */
  listBranches(projectId: string): Promise<CommandResult<"list_branches">>;
  /** Chooses a project's main branch, or with `null` follows `origin/HEAD` again. */
  setMainBranch(projectId: string, branch: string | null): Promise<CommandResult<"set_main_branch">>;
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
 * Failures are thrown as `CommandError` by the services; a proxy is checked here, before anything
 * is written, and kept with its address in one form (SPEC-0001, "设置 · 接口").
 *
 * @sideEffects none until a command arrives.
 * @param options - The services, the feed and the model lister.
 * @returns The commands.
 */
export function createIndexCommands(options: {
  readonly projects: ProjectService;
  /** `refresh` works out a workspace's merge state and changes again. */
  readonly workspaces: Pick<WorkspaceService, "windowFocused" | "refresh">;
  readonly sessions: Pick<SessionManager, "forgetWorkspaces" | "rescan">;
  readonly preferences: PreferenceStore;
  readonly feed: IndexFeed;
  /** Lists a container's models (`createModelLister`). */
  readonly listModels: IndexCommands["listModels"];
  /** Finds pi's working directories, leaving out those inside `taken` (`discoverProjects`). */
  readonly discover: (taken: readonly string[]) => Promise<DiscoveredDirectory[]>;
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
      const { proxy } = changes;
      await options.preferences.set(
        proxy === undefined || proxy === null ? changes : { ...changes, proxy: checkProxy(proxy) },
      );
      options.feed.changed();
      return {};
    },
    listModels: (containerId, refresh) => options.listModels(containerId, refresh),
    listBranches: (projectId) => options.projects.branches(projectId),
    async setMainBranch(projectId, branch) {
      await options.projects.setMainBranch(projectId, branch);
      // Merge states and "+A −D" are counted against the main branch (SPEC-0001, "设置 · 接口").
      for (const workspace of options.projects.workspaces()) {
        if (workspace.projectId === projectId) options.workspaces.refresh(workspace.id);
      }
      return {};
    },
    async discoverProjects() {
      // What `add_project` would refuse as `project_exists`.
      const taken = [
        ...options.projects.projects().map((project) => project.path),
        ...options.projects.workspaces().map((workspace) => workspace.dir),
      ];
      return { directories: await options.discover(taken) };
    },
  };
}

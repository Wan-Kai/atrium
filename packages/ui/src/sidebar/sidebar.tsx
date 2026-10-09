import { type AtriumClient, CommandError, type IndexView } from "@atrium/client";
import type { Appearance, MergeUnknownReason, Project, SessionSummary, Workspace } from "@atrium/protocol";
import {
  Check,
  DotsThree,
  Folder,
  FolderOpen,
  FolderPlus,
  MagnifyingGlass,
  Monitor,
  Moon,
  PlusCircle,
  Sun,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { useClock } from "../state/clock";
import { isDone, isPending, mergeLabels, placeOf, sessionTitle, sortWorkspaces, timeAgo, workspaceName } from "./names";
import { RenameField } from "./rename-field";
import { StatusIcon } from "./status-icon";

/** How many chats the sidebar lists; the rest are in the chats' history (SPEC-0001, "对话"). */
const RECENT_CHATS = 5;

/** The appearances in the order the switch goes through them, with their names and icons. */
const APPEARANCES: readonly { readonly appearance: Appearance; readonly label: string; readonly icon: ReactNode }[] = [
  { appearance: "system", label: "外观：跟随系统", icon: <Monitor size={16} /> },
  { appearance: "light", label: "外观：浅色", icon: <Sun size={16} /> },
  { appearance: "dark", label: "外观：深色", icon: <Moon size={16} /> },
];

/** Why a merge state cannot be told, in words for the hover text (SPEC-0001, "worktree 合并状态"). */
const UNKNOWN_REASONS: Readonly<Record<MergeUnknownReason, string>> = {
  no_main_branch: "无法判断是否已合并：没有主干分支（远程没有 origin/HEAD，项目也没有设置主干）",
  git_too_old: "无法判断是否已合并：git 低于 2.38",
  git_failed: "无法判断是否已合并：git 出错了，稍后会再看",
  base_unknown: "无法判断是否已合并：看不出这个 worktree 从哪里开始",
};

/** Where collapsed projects are remembered in this browser profile (domain-model §7, ViewState). */
const COLLAPSED_KEY = "atrium.collapsedProjects";

/** The class of a sidebar row; selected rows get `--selected`. */
const ROW =
  "group relative my-0.5 flex h-[34px] cursor-default select-none items-center gap-2 rounded-[var(--r)] px-2 text-[var(--text-2)] hover:bg-[var(--hover)]";

/** The class of a small icon button in the sidebar. */
const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]";

/**
 * Explains why adding a project failed, in Chinese.
 *
 * @remarks
 * The host sends codes (AGENTS.md); the wording lives here.
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @param projects - The registered projects, to name the one that exists already.
 * @returns The sentence.
 */
function describeProjectError(error: unknown, projects: readonly Project[]): string {
  if (!(error instanceof CommandError)) return "添加项目失败";
  if (error.code === "project_exists") {
    const name = projects.find((project) => project.id === error.params?.["projectId"])?.name;
    return name === undefined ? "这个目录已经在项目里了" : `这个目录已经在项目「${name}」里了`;
  }
  if (error.code === "path_not_found") return "这个目录不存在";
  if (error.code === "name_taken") return `已经有一个叫「${String(error.params?.["name"] ?? "")}」的项目了`;
  return "宿主出错了，没有完成";
}

/**
 * Reads which projects are collapsed.
 *
 * @remarks
 * A view preference of this browser profile, not the host's (domain-model §7).
 *
 * @sideEffects Reads `localStorage`.
 * @returns The collapsed projects' ids.
 */
function readCollapsed(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The sidebar: new chat, projects with their workspaces, search, chats, and the appearance switch.
 *
 * @remarks
 * Follows SPEC-0001 ("侧栏"); the inbox comes with M1.9. Projects can be collapsed; a collapsed
 * project shows how many worktrees wait to be merged and whether something runs in it. Workspaces
 * show their merge state and whether a session runs in them, and are selected by clicking.
 * Search matches workspace names and session titles, replacing the projects and chats with its
 * results while it has text. Renaming happens in place.
 *
 * @sideEffects Subscribes to the client's list; sends commands; remembers collapsed projects in
 * `localStorage`.
 * @param props - The client, how to start a new chat, and how to choose a folder.
 * @returns The sidebar.
 */
export function Sidebar({
  client,
  onNewChat,
  pickDirectory,
}: {
  readonly client: AtriumClient;
  readonly onNewChat: () => void;
  /** Asks the user for a folder; `undefined` where the app cannot ask. */
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
}) {
  const index = useStore(client.index);
  const now = useClock().now();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Collapses or opens a project, remembering it.
   *
   * @remarks
   * See `readCollapsed`.
   *
   * @sideEffects Updates state and `localStorage`.
   * @param projectId - The project.
   */
  const toggle = (projectId: string): void => {
    const next = new Set(collapsed);
    if (!next.delete(projectId)) next.add(projectId);
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  /**
   * Runs a command, showing its failure under the projects' heading.
   *
   * @remarks
   * Sidebar commands have no other place to report.
   *
   * @sideEffects Sends the command; may set the problem line.
   * @param command - The command.
   */
  const run = (command: () => Promise<unknown>): void => {
    setProblem(null);
    // Fire and forget: the failure is shown.
    void command().catch((error: unknown) => setProblem(describeProjectError(error, client.index.getState().projects)));
  };

  const live = index.sessions.filter((session) => !session.archived);
  const chats = live.filter((session) => session.containerId === "chats").toSorted((a, b) => b.updatedAt - a.updatedAt);
  const appearance = APPEARANCES.find((entry) => entry.appearance === index.preferences.appearance) ?? APPEARANCES[0];

  return (
    <nav
      aria-label="侧栏"
      className="flex h-full w-[270px] shrink-0 flex-col bg-[var(--sidebar-bg)] shadow-[inset_-0.5px_0_0_var(--line)] backdrop-blur-[32px] backdrop-saturate-150"
    >
      <div className="h-[50px] shrink-0 [-webkit-app-region:drag]" />
      <button
        type="button"
        onClick={onNewChat}
        title="新建对话（⌘N）"
        className="mx-3 mb-2 flex h-9 items-center justify-center gap-2 rounded-[var(--r-btn)] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line)] hover:bg-[var(--selected)]"
      >
        <PlusCircle size={16} />
        新建对话
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mt-1.5 flex h-[34px] items-center pr-1 pl-2 text-[var(--text-muted)]">
          <span className="flex-1">项目</span>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label="搜索工作区和会话"
            aria-pressed={searching}
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <MagnifyingGlass size={15} />
          </button>
          {pickDirectory === undefined ? null : (
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="添加项目"
              onClick={() =>
                run(async () => {
                  const path = await pickDirectory();
                  if (path !== null) await client.addProject(path);
                })
              }
            >
              <FolderPlus size={17} />
            </button>
          )}
        </div>
        {problem === null ? null : (
          <p role="alert" className="px-2 pb-1 text-[length:var(--fs-sm)] text-[var(--danger)]">
            {problem}
          </p>
        )}
        {searching ? (
          <div className="relative mt-0.5 mb-1.5">
            <MagnifyingGlass
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-dim)]"
            />
            <input
              aria-label="搜索工作区和会话"
              placeholder="搜索工作区和会话"
              // A search box opened on purpose takes the keyboard at once.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearching(false);
                  setQuery("");
                }
              }}
              className="h-8 w-full rounded-[var(--r-md)] bg-[var(--hover)] pr-2.5 pl-8 text-[length:var(--fs-meta)] shadow-[inset_0_0_0_0.5px_var(--line)] outline-none placeholder:text-[var(--text-dim)] focus:shadow-[inset_0_0_0_0.5px_var(--line-strong),var(--focus-ring)]"
            />
          </div>
        ) : null}
        {query.trim() !== "" ? (
          <SearchResults client={client} index={index} query={query.trim()} now={now} />
        ) : (
          <>
            {index.projects.map((project) => (
              <ProjectRows
                key={project.id}
                client={client}
                index={index}
                project={project}
                open={!collapsed.has(project.id)}
                onToggle={() => toggle(project.id)}
                renaming={renaming}
                setRenaming={setRenaming}
                run={run}
              />
            ))}
            {index.ready && index.projects.length === 0 ? (
              <p className="px-2 py-1 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
                还没有项目，点上面的文件夹按钮添加
              </p>
            ) : null}
            <div className="mt-1.5 flex h-[34px] items-center pl-2 text-[var(--text-muted)]">对话</div>
            {chats.slice(0, RECENT_CHATS).map((session) => (
              <div
                key={session.sessionId}
                role="button"
                tabIndex={0}
                aria-current={index.layout.container === "chats" && activeOf(index) === session.sessionId}
                onClick={() => run(() => client.openSession(session.sessionId))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") run(() => client.openSession(session.sessionId));
                }}
                className={`${ROW} aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-[var(--text)]`}
              >
                <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
                <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                  {timeAgo(session.updatedAt, now)}
                </span>
                <StatusIcon running={session.running} />
              </div>
            ))}
            {chats.length > RECENT_CHATS ? (
              <button
                type="button"
                onClick={() => run(() => client.selectContainer("chats"))}
                className="rounded-[var(--r)] px-2 py-1 text-left text-[length:var(--fs-meta)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
              >
                全部 {chats.length} 个对话
              </button>
            ) : null}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2 pb-3">
        <span className="flex-1" />
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={appearance?.label}
          title={appearance?.label}
          onClick={() => {
            const at = APPEARANCES.findIndex((entry) => entry.appearance === index.preferences.appearance);
            const next = APPEARANCES[(at + 1) % APPEARANCES.length]?.appearance ?? "system";
            run(() => client.setPreferences({ appearance: next }));
          }}
        >
          {appearance?.icon}
        </button>
      </div>
    </nav>
  );
}

/**
 * The session a client has open in its current container.
 *
 * @remarks
 * Lit in the chats list.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The active session, or `null`.
 */
function activeOf(index: IndexView): string | null {
  const container = index.layout.container;
  return container === null ? null : (index.layout.tabs[container]?.active ?? null);
}

/**
 * A project's row and, while open, its workspaces' rows.
 *
 * @remarks
 * See `Sidebar`. A collapsed project holding the current workspace is shown selected.
 *
 * @sideEffects Sends commands when used.
 * @param props - The client, the list, the project, whether it is open, and the sidebar's
 * renaming and command helpers.
 * @returns The rows.
 */
function ProjectRows({
  client,
  index,
  project,
  open,
  onToggle,
  renaming,
  setRenaming,
  run,
}: {
  readonly client: AtriumClient;
  readonly index: IndexView;
  readonly project: Project;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly renaming: string | null;
  readonly setRenaming: (id: string | null) => void;
  readonly run: (command: () => Promise<unknown>) => void;
}) {
  const workspaces = sortWorkspaces(index.workspaces.filter((workspace) => workspace.projectId === project.id));
  /**
   * Whether a session runs in a workspace.
   *
   * @remarks
   * The workspace's status is the highest of its sessions' (domain-model §4); M1.5 knows running.
   *
   * @sideEffects none
   * @param workspace - The workspace.
   * @returns Whether one runs.
   */
  const running = (workspace: Workspace) =>
    index.sessions.some((session) => session.containerId === workspace.id && session.running);
  const pending = workspaces.filter(isPending).length;
  const holdsCurrent = workspaces.some((workspace) => workspace.id === index.layout.container);
  return (
    <div role="group" aria-label={project.name}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-current={!open && holdsCurrent}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter") onToggle();
        }}
        className={`${ROW} aria-[current=true]:bg-[var(--selected)]`}
        data-testid="project-row"
      >
        <span className={open ? "text-[var(--tint)]" : "text-[var(--text-muted)]"}>
          {open ? <FolderOpen size={15} /> : <Folder size={15} />}
        </span>
        {renaming === project.id ? (
          <RenameField
            initial={project.name}
            label="项目名称"
            onDone={(name) => {
              setRenaming(null);
              if (typeof name === "string" && name !== project.name) run(() => client.renameProject(project.id, name));
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        )}
        {!open && pending > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-muted)] tabular-nums before:size-1.5 before:rounded-full before:bg-[var(--attn)]">
            {pending} 待合并
          </span>
        ) : null}
        {!open ? <StatusIcon running={workspaces.some(running)} /> : null}
        <span
          className="hidden group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex"
          // The menu belongs to the row but must not select it.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MenuButton label={`项目 ${project.name}`} compact content={<DotsThree size={14} weight="bold" />}>
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    close();
                    setRenaming(project.id);
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    close();
                    run(() => client.removeProject(project.id));
                  }}
                >
                  从侧栏移除
                </button>
              </>
            )}
          </MenuButton>
        </span>
      </div>
      {open
        ? workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              client={client}
              workspace={workspace}
              selected={index.layout.container === workspace.id}
              running={running(workspace)}
              renaming={renaming === workspace.id}
              setRenaming={setRenaming}
              run={run}
            />
          ))
        : null}
    </div>
  );
}

/**
 * The hover text of a workspace: what kind it is, and its branch or commit when its name hides it.
 *
 * @remarks
 * "本地" and "外部" are only said here (SPEC-0001, "项目与工作区").
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns The text.
 */
function workspaceHint(workspace: Workspace): string {
  const kind =
    workspace.kind === "local" ? "本地工作区（项目目录）" : workspace.external ? "外部 worktree" : "worktree";
  const branch = workspace.alias !== null && workspace.branch !== null ? `分支 ${workspace.branch}；` : "";
  const head = workspace.head === null ? "" : `；提交 ${workspace.head}`;
  return `${branch}${kind}${head}`;
}

/**
 * One workspace's row: its name, merge state and whether something runs in it.
 *
 * @remarks
 * See `Sidebar`; merge labels follow design-language ("标签").
 *
 * @sideEffects Sends commands when used.
 * @param props - The client, the workspace, whether it is selected, runs or is being renamed,
 * and the sidebar's helpers.
 * @returns The row.
 */
function WorkspaceRow({
  client,
  workspace,
  selected,
  running,
  renaming,
  setRenaming,
  run,
}: {
  readonly client: AtriumClient;
  readonly workspace: Workspace;
  readonly selected: boolean;
  readonly running: boolean;
  readonly renaming: boolean;
  readonly setRenaming: (id: string | null) => void;
  readonly run: (command: () => Promise<unknown>) => void;
}) {
  const name = workspaceName(workspace);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected}
      title={workspaceHint(workspace)}
      onClick={() => run(() => client.selectContainer(workspace.id))}
      onKeyDown={(event) => {
        if (event.key === "Enter") run(() => client.selectContainer(workspace.id));
      }}
      className={`${ROW} pl-9 aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-[var(--text)]`}
      data-testid="workspace-row"
    >
      {renaming ? (
        <RenameField
          initial={name}
          label="工作区名称"
          onDone={(alias) => {
            setRenaming(null);
            if (alias !== undefined && alias !== workspace.alias)
              run(() => client.renameWorkspace(workspace.id, alias));
          }}
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${isDone(workspace) ? "opacity-50" : ""}`}>{name}</span>
      )}
      <span className="flex shrink-0 items-center gap-2.5 group-hover:hidden">
        <MergeLabels workspace={workspace} />
      </span>
      <StatusIcon running={running} />
      <span
        className="hidden group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex"
        // The menu belongs to the row but must not select it.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <MenuButton label={`工作区 ${name}`} compact content={<DotsThree size={14} weight="bold" />}>
          {(close) => (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setRenaming(workspace.id);
              }}
            >
              重命名
            </button>
          )}
        </MenuButton>
      </span>
    </div>
  );
}

/**
 * A workspace's merge labels, as plain text.
 *
 * @remarks
 * "• 未提交", orange bold "↑N", green "✓ 已合并", dim "已移除", dimmer "状态未知" with the reason on
 * hover (design-language, "标签").
 *
 * @sideEffects none
 * @param props - The workspace.
 * @returns The labels.
 */
function MergeLabels({ workspace }: { readonly workspace: Pick<Workspace, "merge"> }) {
  return mergeLabels(workspace).map((label) => {
    if (label.kind === "dirty") {
      return (
        <span
          key="dirty"
          title="worktree 里有未提交的改动"
          className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-muted)] before:size-1.5 before:rounded-full before:bg-[var(--attn)]"
        >
          未提交
        </span>
      );
    }
    if (label.kind === "ahead") {
      return (
        <span
          key="ahead"
          title={`未合并：比主干多 ${label.count} 个提交`}
          className="text-[length:var(--fs-sm)] font-semibold text-[var(--attn-text)] tabular-nums"
        >
          ↑{label.count}
        </span>
      );
    }
    if (label.kind === "merged") {
      return (
        <span
          key="merged"
          title="改动已全部进入主干（含 squash / rebase 合并）"
          className="flex items-center gap-0.5 text-[length:var(--fs-sm)] text-[var(--ok-text)]"
        >
          <Check size={10} weight="bold" />
          已合并
        </span>
      );
    }
    if (label.kind === "removed") {
      return (
        <span key="removed" title="worktree 目录已不存在" className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          已移除
        </span>
      );
    }
    return (
      <span
        key="unknown"
        title={UNKNOWN_REASONS[label.reason ?? "git_failed"]}
        className="text-[length:var(--fs-sm)] text-[var(--text-dim)] opacity-70"
      >
        状态未知
      </span>
    );
  });
}

/**
 * Search results: matching workspaces, then matching sessions.
 *
 * @remarks
 * Workspace names and session titles, ignoring case (SPEC-0001, "搜索"); archived sessions are
 * left out. Sessions show where they live on a second line.
 *
 * @sideEffects Sends commands when used.
 * @param props - The client, the list, the query and the time now.
 * @returns The results.
 */
function SearchResults({
  client,
  index,
  query,
  now,
}: {
  readonly client: AtriumClient;
  readonly index: IndexView;
  readonly query: string;
  readonly now: number;
}) {
  const needle = query.toLowerCase();
  const workspaces = index.workspaces.filter((workspace) => workspaceName(workspace).toLowerCase().includes(needle));
  const sessions = index.sessions
    .filter((session) => !session.archived && sessionTitle(session).toLowerCase().includes(needle))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  /**
   * Opens a found session.
   *
   * @remarks
   * A failure shows in the session's area.
   *
   * @sideEffects Sends `open_session`.
   * @param session - The session.
   */
  const open = (session: SessionSummary) => {
    // Fire and forget: opening shows the session or its failure there.
    void client.openSession(session.sessionId).catch(() => undefined);
  };
  if (workspaces.length === 0 && sessions.length === 0) {
    return <p className="px-2 py-1 text-[length:var(--fs-meta)] text-[var(--text-dim)]">没有匹配的工作区或会话</p>;
  }
  return (
    <div role="region" aria-label="搜索结果">
      {workspaces.length > 0 ? (
        <div className="px-2 pt-2 pb-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">工作区</div>
      ) : null}
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          onClick={() => {
            // Fire and forget: the list shows where the client is.
            void client.selectContainer(workspace.id).catch(() => undefined);
          }}
          className={`${ROW} h-auto w-full py-[7px] text-left`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{workspaceName(workspace)}</span>
            <span className="block text-[length:var(--fs-sm)] text-[var(--text-dim)]">
              {index.projects.find((project) => project.id === workspace.projectId)?.name}
            </span>
          </span>
          <MergeLabels workspace={workspace} />
        </button>
      ))}
      {sessions.length > 0 ? (
        <div className="px-2 pt-2 pb-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">会话</div>
      ) : null}
      {sessions.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          onClick={() => open(session)}
          className={`${ROW} h-auto w-full items-start py-[7px] text-left`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{sessionTitle(session)}</span>
            <span className="block text-[length:var(--fs-sm)] text-[var(--text-dim)]">
              {placeOf(index, session.containerId)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2.5 pt-px text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            {timeAgo(session.updatedAt, now)}
            <StatusIcon running={session.running} />
          </span>
        </button>
      ))}
    </div>
  );
}

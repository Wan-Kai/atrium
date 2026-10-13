import { type AtriumClient, CommandError, type IndexView } from "@atrium/client";
import type { Appearance, Chat, MergeUnknownReason, Project, SessionSummary, Workspace } from "@atrium/protocol";
import {
  ArrowUp,
  CaretDown,
  CaretUp,
  ChatAdd,
  DotsThree,
  Folder,
  FolderOpen,
  FolderPlus,
  GitMerge,
  MagnifyingGlass,
  Monitor,
  Moon,
  GearSix,
  Plus,
  Sun,
  Trash,
} from "../design/icons";
import { type ReactNode, createContext, use, useState } from "react";
import { useStore } from "zustand";
import { Fold } from "../chat/fold";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { UpdateDot } from "../settings/settings-panel";
import { piUpdateAvailable } from "../setup/pi-version";
import { useClock } from "../state/clock";
import {
  ArchiveDialog,
  ArchivedChats,
  ArchivedWorkspaces,
  ChatArchiveDialog,
  describeChatArchiveError,
  describeRestoreError,
} from "./archive";
import {
  chatName,
  isDone,
  isPending,
  mergeLabels,
  placeOf,
  sessionTitle,
  sortWorkspaces,
  timeAgo,
  workspaceName,
} from "./names";
import { RenameField } from "./rename-field";
import { INBOX_SHOWN, type RowStatus, inboxOf, sessionStatus, topStatus } from "./status";
import { StatusIcon } from "./status-icon";

/** How many chats the sidebar lists before "显示全部 N 个" (SPEC-0001, "对话"). */
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

/**
 * A row's archive button, shown on hover left of its "···": a red trash can on a faint red.
 *
 * @remarks
 * The one icon with a ground (design-language, "侧栏"): archiving removes a worktree's directory or
 * puts a chat away, and the red says so where the old drawer said nothing.
 */
const ROW_ARCHIVE =
  "rounded-[var(--r)] bg-[var(--danger-soft)] p-1 text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-[var(--danger-soft)]";

/** Where collapsed projects are remembered in this browser profile (domain-model §7, ViewState). */
const COLLAPSED_KEY = "atrium.collapsedProjects";

/** Where an opened inbox card is remembered in this browser profile, like collapsed projects. */
const INBOX_OPEN_KEY = "atrium.inboxOpen";

/** The class of a sidebar row; selected rows get `--selected`. */
const ROW =
  "group relative my-0.5 flex h-[34px] cursor-default select-none items-center gap-2 rounded-[var(--r)] px-2 text-[var(--text-2)] hover:bg-[var(--hover)]";

/** How long a project's workspaces take to fold away or unfold (design-language, "动效"). */
const PROJECT_FOLD_MS = 280;

/** The class of a small icon button in the sidebar. */
const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]";

/**
 * Explains why a sidebar command failed, in Chinese: adding a project, renaming a chat.
 *
 * @remarks
 * The host sends codes (AGENTS.md); the wording lives here.
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @param projects - The registered projects, to name the one that exists already.
 * @returns The sentence.
 */
export function describeProjectError(error: unknown, projects: readonly Project[]): string {
  if (!(error instanceof CommandError)) return "添加项目失败";
  if (error.code === "project_exists") {
    const name = projects.find((project) => project.id === error.params?.["projectId"])?.name;
    return name === undefined ? "这个目录已经在项目里了" : `这个目录已经在项目「${name}」里了`;
  }
  if (error.code === "path_not_found") return "这个目录不存在";
  if (error.code === "chat_not_found") return "这个对话已经不在了";
  if (error.code === "name_taken") return `已经有一个叫「${String(error.params?.["name"] ?? "")}」的项目了`;
  if (error.code === "worktree_restore_failed") return describeRestoreError(error);
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
 * The sidebar: projects with their workspaces, search, chats with "新建对话" by their heading, the
 * inbox's card, the settings and the appearance switch.
 *
 * @remarks
 * Follows SPEC-0001 ("侧栏"). The inbox stays at the bottom, over "设置", while the rest scrolls
 * above it (SPEC-0001, "收件箱"). Projects can be collapsed; a collapsed
 * project shows how many worktrees wait to be merged and whether something runs in it. Workspaces
 * show their merge state and whether a session runs in them, and are selected by clicking.
 * Chats are listed like workspaces, by their latest activity. Search matches workspace names, chat
 * names and session titles, replacing the projects and chats with its results while it has text. Renaming happens in place. "设置" carries a blue dot while a newer pi
 * is out (SPEC-0001, "设置 · pi"). While a project's new-workspace page shows, its row is the one
 * selected, and going to a workspace, chat or session leaves the page (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects Subscribes to the client's list and setup; sends commands; remembers collapsed
 * projects and the inbox's card in `localStorage`.
 * @param props - The client, how to start a new chat, how to choose a folder, how to open the
 * settings, and the new-workspace page.
 * @returns The sidebar.
 */
export function Sidebar({
  client,
  onNewChat,
  pickDirectory,
  onSettings,
  page,
}: {
  readonly client: AtriumClient;
  readonly onNewChat: () => void;
  /** Asks the user for a folder; `undefined` where the app cannot ask. */
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly onSettings: () => void;
  /** The new-workspace page; without it, projects have no "+". */
  readonly page?: SidebarPage;
}) {
  const listed = useStore(client.index);
  // While the page shows, the client's place is not where the user is.
  const index = page?.projectId == null ? listed : { ...listed, layout: { ...listed.layout, container: null } };
  const update = useStore(client.setup, (setup) => setup.state !== null && piUpdateAvailable(setup.state.pi));
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
   * Sidebar commands have no other place to report. A command whose failures read otherwise says
   * how; the rest are explained as `describeProjectError` does.
   *
   * @sideEffects Sends the command; may set the problem line.
   * @param command - The command.
   * @param describe - How to explain its failure.
   */
  const run = (
    command: () => Promise<unknown>,
    describe = (error: unknown) => describeProjectError(error, client.index.getState().projects),
  ): void => {
    setProblem(null);
    // Fire and forget: the failure is shown.
    void command().catch((error: unknown) => setProblem(describe(error)));
  };

  const appearance = APPEARANCES.find((entry) => entry.appearance === index.preferences.appearance) ?? APPEARANCES[0];

  return (
    <LeavePage value={page?.leave ?? stay}>
      <nav
        aria-label="侧栏"
        className="flex h-full w-[270px] shrink-0 flex-col bg-[var(--sidebar-bg)] shadow-[inset_-0.5px_0_0_var(--line)] backdrop-blur-[32px] backdrop-saturate-150"
      >
        <div className="h-[50px] shrink-0 [-webkit-app-region:drag]" />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <div className="mt-1.5 flex h-[34px] items-center pr-1 pl-2 text-[var(--text-muted)]">
            <span className="flex-1">项目</span>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="搜索工作区、对话和会话"
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
                aria-label="搜索工作区、对话和会话"
                placeholder="搜索工作区、对话和会话"
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
                  onNewWorkspace={page === undefined ? undefined : () => page.open(project.id)}
                  pageHere={page?.projectId === project.id}
                  open={!collapsed.has(project.id)}
                  onToggle={() => toggle(project.id)}
                  renaming={renaming}
                  setRenaming={setRenaming}
                  run={run}
                  now={now}
                />
              ))}
              {index.ready && index.projects.length === 0 ? (
                <p className="px-2 py-1 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
                  还没有项目，点上面的文件夹按钮添加
                </p>
              ) : null}
              <ChatRows
                client={client}
                index={index}
                now={now}
                onNewChat={onNewChat}
                renaming={renaming}
                setRenaming={setRenaming}
                run={run}
              />
            </>
          )}
        </div>
        <Inbox client={client} index={index} now={now} />
        <div className="flex shrink-0 items-center gap-1 px-3 pt-2 pb-3">
          <button
            type="button"
            onClick={onSettings}
            title="设置（⌘,）"
            className="inline-flex h-7 items-center gap-2 rounded-[var(--r)] px-2 text-[var(--text-2)] hover:bg-[var(--hover)]"
          >
            <GearSix size={16} className="text-[var(--text-muted)]" />
            设置
            {update ? <UpdateDot /> : null}
          </button>
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
    </LeavePage>
  );
}

/** The new-workspace page, as the sidebar opens, marks and leaves it (SPEC-0001, "M1.11 的新建工作区"). */
export interface SidebarPage {
  /** The project whose page shows, or `null`. */
  readonly projectId: string | null;
  readonly open: (projectId: string) => void;
  readonly leave: () => void;
}

/** Leaves the new-workspace page, as going to a workspace, chat or session from the sidebar does. */
const LeavePage = createContext<() => void>(() => undefined);

/**
 * Leaves nothing.
 *
 * @remarks
 * For a sidebar given no new-workspace page.
 *
 * @sideEffects none
 */
function stay(): void {
  // Nothing: see above.
}

/**
 * The session a client has open in its current container.
 *
 * @remarks
 * Lit in the inbox.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The active session, or `null`.
 */
function activeOf(index: IndexView): string | null {
  const container = index.layout.container;
  return container === null ? null : (index.layout.tabs[container]?.active ?? null);
}

/** A chat as the sidebar lists it: with its sessions not archived, its latest activity and status. */
interface ListedChat {
  readonly chat: Chat;
  readonly sessions: readonly SessionSummary[];
  readonly at: number;
  readonly status: RowStatus;
}

/**
 * The chats the sidebar lists, latest activity first.
 *
 * @remarks
 * An archived chat, or one whose sessions are all archived, is left out; its activity is its
 * sessions' latest, its status their highest (SPEC-0001, "对话", "M1.11 的对话归档").
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The chats.
 */
function listedChats(index: Pick<IndexView, "chats" | "sessions">): ListedChat[] {
  return index.chats
    .filter((chat) => chat.archivedAt === null)
    .map((chat) => {
      const sessions = index.sessions.filter((session) => session.containerId === chat.id && !session.archived);
      return {
        chat,
        sessions,
        at: Math.max(...sessions.map((session) => session.updatedAt)),
        status: topStatus(sessions.map(sessionStatus)),
      };
    })
    .filter((listed) => listed.sessions.length > 0)
    .toSorted((a, b) => b.at - a.at);
}

/**
 * Selects a chat, opening its latest session when it has no tab open.
 *
 * @remarks
 * A chat seldom wants an empty state: clicking it should show something (SPEC-0001, "对话").
 *
 * @sideEffects Sends `select_container` or `open_session`.
 * @param client - The client.
 * @param listed - The chat.
 * @returns When the host answered.
 */
async function selectChat(client: AtriumClient, listed: ListedChat): Promise<unknown> {
  const tabs = client.index.getState().layout.tabs[listed.chat.id];
  const latest = listed.sessions.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  if ((tabs === undefined || tabs.open.length === 0) && latest !== undefined) {
    return client.openSession(latest.sessionId);
  }
  return client.selectContainer(listed.chat.id);
}

/**
 * The "对话" heading with "新建对话" on its right, and the chats' rows: the latest five, then
 * "显示全部 N 个".
 *
 * @remarks
 * Shown without chats too, as its heading holds the way to start one (SPEC-0001, "对话"). Each chat is a
 * container like a workspace (ADR-0007): its row shows its name, latest activity and status, is
 * lit while selected; on hover its archive button archives it, asking first only when some of its
 * sessions run, and its "···" menu renames it (SPEC-0001, "M1.11 的对话归档"). The rest of the chats open in place, and
 * "收起" closes them again; the archived ones are listed last.
 *
 * @sideEffects Sends commands when used.
 * @param props - The client, the list, the time now, how to start a new chat, and the sidebar's
 * renaming and command helpers.
 * @returns The section.
 */
function ChatRows({
  client,
  index,
  now,
  onNewChat,
  renaming,
  setRenaming,
  run,
}: {
  readonly client: AtriumClient;
  readonly index: IndexView;
  readonly now: number;
  readonly onNewChat: () => void;
  readonly renaming: string | null;
  readonly setRenaming: (id: string | null) => void;
  readonly run: (command: () => Promise<unknown>, describe?: (error: unknown) => string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [archiving, setArchiving] = useState<{ readonly chat: Chat; readonly running: number } | null>(null);
  const chats = listedChats(index);
  /**
   * Archives a chat, explaining a failure in the problem line.
   *
   * @remarks
   * See `ChatRows`.
   *
   * @sideEffects Sends `archive_chat`.
   * @param chatId - The chat.
   */
  const archive = (chatId: string): void =>
    run(
      () => client.archiveChat(chatId),
      (error) => describeChatArchiveError(error, "没能归档这个对话"),
    );
  const shown = expanded ? chats : chats.slice(0, RECENT_CHATS);
  const leave = use(LeavePage);
  return (
    <section aria-label="对话">
      <div className="mt-1.5 flex h-[34px] items-center pr-1 pl-2 text-[var(--text-muted)]">
        <span className="flex-1">对话</span>
        <button type="button" className={ICON_BUTTON} aria-label="新建对话" title="新建对话（⌘N）" onClick={onNewChat}>
          <ChatAdd size={17} />
        </button>
      </div>
      {shown.map((listed) => {
        const { chat } = listed;
        const name = chatName(chat, index.sessions);
        return (
          <div
            key={chat.id}
            role="button"
            tabIndex={0}
            aria-current={index.layout.container === chat.id}
            onClick={() => {
              leave();
              run(() => selectChat(client, listed));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              leave();
              run(() => selectChat(client, listed));
            }}
            className={`${ROW} aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-[var(--text)]`}
            data-testid="chat-row"
          >
            {renaming === chat.id ? (
              <RenameField
                initial={name}
                label="对话名称"
                onDone={(alias) => {
                  setRenaming(null);
                  if (alias !== undefined && alias !== chat.alias) run(() => client.renameChat(chat.id, alias));
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{name}</span>
            )}
            <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)] group-hover:hidden">
              {timeAgo(listed.at, now)}
            </span>
            <StatusIcon status={listed.status} />
            <span
              className="hidden gap-1 group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex"
              // The menu belongs to the row but must not select it.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                aria-label={`归档对话 ${name}`}
                title="归档"
                onClick={() => {
                  const running = listed.sessions.filter((session) => session.running).length;
                  if (running > 0) setArchiving({ chat, running });
                  else archive(chat.id);
                }}
                className={ROW_ARCHIVE}
              >
                <Trash size={14} />
              </button>
              <MenuButton label={`对话 ${name}`} compact content={<DotsThree size={14} weight="bold" />}>
                {(close) => (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      close();
                      setRenaming(chat.id);
                    }}
                  >
                    重命名
                  </button>
                )}
              </MenuButton>
            </span>
          </div>
        );
      })}
      {chats.length > RECENT_CHATS ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="rounded-[var(--r)] px-2 py-1 text-left text-[length:var(--fs-meta)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
        >
          {expanded ? "收起" : `显示全部 ${chats.length} 个`}
        </button>
      ) : null}
      <ArchivedChats
        client={client}
        chats={index.chats.filter((chat) => chat.archivedAt !== null)}
        sessions={index.sessions}
        now={now}
        run={run}
      />
      {archiving === null ? null : (
        <ChatArchiveDialog
          name={chatName(archiving.chat, index.sessions)}
          running={archiving.running}
          onArchive={() => archive(archiving.chat.id)}
          onClose={() => setArchiving(null)}
        />
      )}
    </section>
  );
}

/**
 * A project's row and, while open, its workspaces' rows.
 *
 * @remarks
 * See `Sidebar`. A collapsed project holding the current workspace is shown selected. Archived
 * workspaces are left out, listed only in the project's menu; archiving one asks first
 * (SPEC-0001, "M1.11 的工作区归档"). Opening and closing fold the workspaces' rows in and out and
 * cross-fade the folder (SPEC-0001, "侧栏"; design-language, "动效"). Hovering shows "+", which
 * opens the project's new-workspace page; the row is selected while the page shows (SPEC-0001,
 * "M1.11 的新建工作区").
 *
 * @sideEffects Sends commands when used; animates the rows and the folder when opened or closed.
 * @param props - The client, the list, the project, whether it is open, how to open its
 * new-workspace page and whether it shows, the sidebar's renaming and command helpers, and the
 * time now.
 * @returns The rows.
 */
function ProjectRows({
  client,
  index,
  project,
  open,
  onToggle,
  onNewWorkspace,
  pageHere,
  renaming,
  setRenaming,
  run,
  now,
}: {
  readonly client: AtriumClient;
  readonly index: IndexView;
  readonly project: Project;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Opens the project's new-workspace page; without it, the row has no "+". */
  readonly onNewWorkspace: (() => void) | undefined;
  /** Whether the project's new-workspace page shows, which selects the row. */
  readonly pageHere: boolean;
  readonly renaming: string | null;
  readonly setRenaming: (id: string | null) => void;
  readonly run: (command: () => Promise<unknown>) => void;
  readonly now: number;
}) {
  const [archiving, setArchiving] = useState<Workspace | null>(null);
  const own = index.workspaces.filter((workspace) => workspace.projectId === project.id);
  const workspaces = sortWorkspaces(own.filter((workspace) => workspace.archivedAt === null));
  const archived = own.filter((workspace) => workspace.archivedAt !== null);
  /**
   * A workspace's status.
   *
   * @remarks
   * The highest of its sessions' not archived (SPEC-0001, "会话状态").
   *
   * @sideEffects none
   * @param workspace - The workspace.
   * @returns Its status.
   */
  const status = (workspace: Workspace): RowStatus =>
    topStatus(
      index.sessions.filter((session) => session.containerId === workspace.id && !session.archived).map(sessionStatus),
    );
  const pending = workspaces.filter(isPending).length;
  const holdsCurrent = workspaces.some((workspace) => workspace.id === index.layout.container);
  return (
    <div role="group" aria-label={project.name}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-current={pageHere || (!open && holdsCurrent)}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter") onToggle();
        }}
        className={`${ROW} aria-[current=true]:bg-[var(--selected)]`}
        data-testid="project-row"
      >
        <span className={`atrium-folder ${open ? "text-[var(--tint)]" : "text-[var(--text-muted)]"}`}>
          <Folder size={15} data-folder="closed" data-shown={!open} />
          <FolderOpen size={15} data-folder="open" data-shown={open} />
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
        {!open ? <StatusIcon status={topStatus(workspaces.map(status))} /> : null}
        <span
          className="hidden group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex"
          // The menu belongs to the row but must not select it.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {onNewWorkspace === undefined ? null : (
            <button
              type="button"
              aria-label={`在 ${project.name} 新建工作区`}
              title="新建工作区"
              onClick={onNewWorkspace}
              className="rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
            >
              <Plus size={14} />
            </button>
          )}
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
                {archived.length > 0 ? (
                  <ArchivedWorkspaces client={client} workspaces={archived} now={now} run={run} close={close} />
                ) : null}
              </>
            )}
          </MenuButton>
        </span>
      </div>
      {/* The rows' 2px gaps stay the same open, folding and folded (design-language, "动效"). */}
      <Fold
        open={open}
        testId="project-workspaces"
        duration={PROJECT_FOLD_MS}
        className="-mb-0.5 flow-root [&>:first-child]:mt-0"
      >
        {workspaces.map((workspace) => (
          <WorkspaceRow
            key={workspace.id}
            client={client}
            workspace={workspace}
            selected={index.layout.container === workspace.id}
            status={status(workspace)}
            renaming={renaming === workspace.id}
            setRenaming={setRenaming}
            run={run}
            onArchive={() => setArchiving(workspace)}
          />
        ))}
      </Fold>
      {archiving === null ? null : (
        <ArchiveDialog
          client={client}
          workspace={archiving}
          running={
            index.sessions.filter(
              (session) => session.containerId === archiving.id && !session.archived && session.running,
            ).length
          }
          onClose={() => setArchiving(null)}
        />
      )}
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
 * See `Sidebar`; merge labels follow design-language ("标签"). On hover a worktree's archive
 * button asks to archive it, faded and saying why while it has changes not committed (SPEC-0001,
 * "M1.11 的工作区归档"); `aria-disabled` rather than `disabled`, so the reason still shows.
 *
 * @sideEffects Sends commands when used.
 * @param props - The client, the workspace, whether it is selected, runs or is being renamed,
 * the sidebar's helpers, and how to ask to archive it.
 * @returns The row.
 */
function WorkspaceRow({
  client,
  workspace,
  selected,
  status,
  renaming,
  setRenaming,
  run,
  onArchive,
}: {
  readonly client: AtriumClient;
  readonly workspace: Workspace;
  readonly selected: boolean;
  readonly status: RowStatus;
  readonly renaming: boolean;
  readonly setRenaming: (id: string | null) => void;
  readonly run: (command: () => Promise<unknown>) => void;
  readonly onArchive: () => void;
}) {
  const name = workspaceName(workspace);
  const leave = use(LeavePage);
  const dirty = workspace.merge?.dirty === true;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected}
      title={workspaceHint(workspace)}
      onClick={() => {
        leave();
        run(() => client.selectContainer(workspace.id));
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        leave();
        run(() => client.selectContainer(workspace.id));
      }}
      className={`${ROW} pl-9 aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-[var(--text)]`}
      data-testid="workspace-row"
      data-fold-row
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
      <StatusIcon status={status} />
      <span
        className="hidden gap-1 group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex"
        // The menu belongs to the row but must not select it.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {workspace.kind === "worktree" ? (
          <button
            type="button"
            aria-label={`归档工作区 ${name}`}
            aria-disabled={dirty}
            title={dirty ? "有未提交的改动，先提交或丢弃" : "归档"}
            onClick={() => {
              if (!dirty) onArchive();
            }}
            className={ROW_ARCHIVE}
          >
            <Trash size={14} />
          </button>
        ) : null}
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
 * "• 未提交", orange bold "↑N" (an arrow icon, not the ↑ character), green "已合并" after a merge icon, dim "已移除", dimmer "状态未知" with the reason on
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
          className="flex items-center gap-px text-[length:var(--fs-sm)] font-semibold text-[var(--attn-text)] tabular-nums"
        >
          <ArrowUp size={12} weight="bold" aria-hidden="true" />
          {label.count}
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
          <GitMerge size={12} weight="bold" aria-hidden="true" />
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
 * Search results: matching workspaces, then chats, then sessions.
 *
 * @remarks
 * Workspace names, chat names and session titles, ignoring case (SPEC-0001, "搜索"); archived
 * workspaces and sessions, and chats with nothing else, are left out. Sessions show where they live on a second
 * line.
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
  const leave = use(LeavePage);
  const needle = query.toLowerCase();
  const workspaces = index.workspaces.filter(
    (workspace) => workspace.archivedAt === null && workspaceName(workspace).toLowerCase().includes(needle),
  );
  const chats = listedChats(index).filter((listed) =>
    chatName(listed.chat, index.sessions).toLowerCase().includes(needle),
  );
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
    leave();
    // Fire and forget: opening shows the session or its failure there.
    void client.openSession(session.sessionId).catch(() => undefined);
  };
  if (workspaces.length === 0 && chats.length === 0 && sessions.length === 0) {
    return (
      <p className="px-2 py-1 text-[length:var(--fs-meta)] text-[var(--text-dim)]">没有匹配的工作区、对话或会话</p>
    );
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
            leave();
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
      {chats.length > 0 ? (
        <div className="px-2 pt-2 pb-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">对话</div>
      ) : null}
      {chats.map((listed) => (
        <button
          key={listed.chat.id}
          type="button"
          onClick={() => {
            leave();
            // Fire and forget: the list shows where the client is.
            void selectChat(client, listed).catch(() => undefined);
          }}
          className={`${ROW} w-full text-left`}
        >
          <span className="min-w-0 flex-1 truncate">{chatName(listed.chat, index.sessions)}</span>
          <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">{timeAgo(listed.at, now)}</span>
        </button>
      ))}
      {sessions.length > 0 ? (
        <div className="px-2 pt-2 pb-0.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">会话</div>
      ) : null}
      {sessions.map((session) => (
        <SessionLine
          key={session.sessionId}
          index={index}
          session={session}
          when={timeAgo(session.updatedAt, now)}
          status={sessionStatus(session)}
          onOpen={() => open(session)}
        />
      ))}
    </div>
  );
}

/**
 * A session on two lines: its title and where it lives, with a time and its status.
 *
 * @remarks
 * The inbox and the search results show sessions alike (SPEC-0001, "收件箱", "搜索").
 *
 * @sideEffects Calls `onOpen` when clicked.
 * @param props - The list, the session, the time to show, its status, whether it is the one
 * shown, and what opening it does.
 * @returns The row.
 */
function SessionLine({
  index,
  session,
  when,
  status,
  current,
  onOpen,
  testId,
}: {
  readonly index: IndexView;
  readonly session: SessionSummary;
  readonly when: string;
  readonly status: RowStatus;
  readonly current?: boolean;
  readonly onOpen: () => void;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current}
      data-testid={testId}
      className={`${ROW} h-auto w-full items-start py-[7px] text-left aria-[current=true]:bg-[var(--selected)] aria-[current=true]:text-[var(--text)]`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{sessionTitle(session)}</span>
        <span className="block text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {placeOf(index, session.containerId)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2.5 pt-px text-[length:var(--fs-sm)] text-[var(--text-dim)]">
        {when}
        <StatusIcon status={status} />
      </span>
    </button>
  );
}

/**
 * The inbox: a card at the bottom of the sidebar with the sessions waiting for the user, across
 * every project and chat.
 *
 * @remarks
 * SPEC-0001 ("收件箱"): left out when empty or switched off in the settings. Folded into its
 * heading at first, with how many and one icon of each status there, by priority; its heading opens
 * and folds it, remembered in this browser profile like collapsed projects. It opens upwards, the
 * list above the heading, so the heading stays where it was clicked. Open, it shows three
 * at most until "还有 N 条" opens the rest, which "收起" closes again; a long list scrolls in the
 * card. A row is lit while its session is the one shown.
 *
 * @sideEffects Sends `open_session` when a row is clicked; remembers the card opened or folded in
 * `localStorage`.
 * @param props - The client, the list and the time now.
 * @returns The inbox, or nothing.
 */
function Inbox({
  client,
  index,
  now,
}: {
  readonly client: AtriumClient;
  readonly index: IndexView;
  readonly now: number;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(INBOX_OPEN_KEY) === "true");
  const [expanded, setExpanded] = useState(false);
  const leave = use(LeavePage);
  const entries = inboxOf(index.sessions);
  if (!index.preferences.inbox || entries.length === 0) return null;
  const shown = expanded ? entries : entries.slice(0, INBOX_SHOWN);
  const active = activeOf(index);
  // Sorted by priority already, so each status comes where it ranks.
  const statuses = [...new Set(entries.map(({ status }) => status))];
  return (
    <section
      aria-label="等你处理"
      className="mx-3 shrink-0 rounded-[14px] bg-[var(--surface-1)] px-1 pt-0.5 pb-1 shadow-[var(--card-shadow)]"
    >
      {/* Opens upwards: the heading stays put, the list grows above it. */}
      {open ? (
        <div className="flex max-h-[228px] flex-col overflow-y-auto">
          {shown.map(({ session, status, at }) => (
            <SessionLine
              key={session.sessionId}
              index={index}
              session={session}
              when={timeAgo(at, now)}
              status={status}
              current={index.layout.container === session.containerId && active === session.sessionId}
              testId="inbox-row"
              onOpen={() => {
                leave();
                // Fire and forget: opening shows the session or its failure there.
                void client.openSession(session.sessionId).catch(() => undefined);
              }}
            />
          ))}
          {entries.length > INBOX_SHOWN ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="shrink-0 rounded-[var(--r)] px-2 py-1 text-left text-[length:var(--fs-meta)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
            >
              {expanded ? "收起" : `还有 ${entries.length - INBOX_SHOWN} 条`}
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          localStorage.setItem(INBOX_OPEN_KEY, String(!open));
        }}
        className="flex h-8 w-full items-center gap-1.5 rounded-[var(--r)] pr-1.5 pl-2 text-left text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
      >
        等你处理
        <span className="rounded-[var(--r-pill)] bg-[var(--attn-soft)] px-[7px] text-[length:var(--fs-sm)] leading-[18px] font-semibold text-[var(--attn-text)] tabular-nums">
          {entries.length}
        </span>
        <span className="flex-1" />
        {open ? null : statuses.map((status) => <StatusIcon key={status} status={status} />)}
        {open ? <CaretDown size={14} /> : <CaretUp size={14} />}
      </button>
    </section>
  );
}

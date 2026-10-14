import { type AtriumClient, CommandError } from "@atrium/client";
import type { CommandResult } from "@atrium/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { Composer } from "../chat/composer";
import { describeLaunchError } from "../chat/conversation-area";
import { LaunchView } from "../chat/launch-timeline";
import { MenuButton } from "../chat/menu-button";
import { ModelPicker } from "../chat/model-picker";
import {
  ArrowUp,
  CaretDown,
  Check,
  Folder,
  GitBranch,
  GitCommit,
  MagnifyingGlass,
  Monitor,
  PencilSimple,
  Plus,
  Sparkle,
} from "../design/icons";
import {
  type NewWorkspacePage as Page,
  type NewWorkspaceState,
  baseName,
  baseRef,
  choose,
  closePage,
  defaultBase,
  holdsBack,
  launch,
  pageDraftKey,
  pageModel,
} from "../state/new-workspace";
import { pageDrafts } from "../state/use-draft";
import { sortWorkspaces, workspaceName } from "../sidebar/names";
import { RenameField } from "../sidebar/rename-field";

/** What `list_bases` answered for a project, or why it did not. */
type Bases =
  | { readonly projectId: string; readonly kind: "ready"; readonly bases: CommandResult<"list_bases"> }
  | { readonly projectId: string; readonly kind: "not_git" | "failed" };

/** The class of a heading inside a choice's menu. */
const MENU_HEADING = "px-2.5 pt-1.5 pb-1 text-[length:var(--fs-sm)] text-[var(--text-dim)]";

/** The class of a small label after a base's name. */
const BADGE = "inline-flex h-4 shrink-0 items-center rounded-[4px] px-[5px] text-[11px]";

/**
 * One choice in a menu above the page's input box: its icon, name and what is worth knowing about
 * it on one line, ticked when chosen.
 *
 * @remarks
 * design-language ("新建工作区页"): 32px rows, the name cut short when long, the tick in a 14px
 * slot of its own so the names line up whether ticked or not.
 *
 * @sideEffects none
 * @param props - The icon, name, extra words, whether it is chosen, its hover text, whether it can
 * be chosen, and what choosing it does.
 * @returns The item.
 */
function ChoiceItem({
  icon,
  name,
  meta,
  checked,
  title,
  disabled = false,
  onChoose,
}: {
  readonly icon: ReactNode;
  readonly name: ReactNode;
  readonly meta?: ReactNode;
  readonly checked: boolean;
  readonly title?: string | undefined;
  readonly disabled?: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={onChoose}
      className="flex h-8 w-full items-center gap-2 rounded-[var(--r)] px-2.5 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] enabled:hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:text-[var(--text-dim)]"
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{name}</span>
      {meta === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {meta}
        </span>
      )}
      <span className="flex w-3.5 shrink-0 justify-center text-[var(--tint)]">
        {checked ? <Check size={14} /> : null}
      </span>
    </button>
  );
}

/**
 * Where a project lies: its directory's last two levels, or the whole of it when that short.
 *
 * @remarks
 * design-language ("新建工作区页"): enough to tell projects of the same name apart; the whole path
 * shows on hover.
 *
 * @sideEffects none
 * @param path - The project's path.
 * @returns The words, e.g. "…/MT/projects".
 */
function parentLabel(path: string): string {
  const parent = path.split("/").slice(0, -1);
  return parent.length > 3 ? `…/${parent.slice(-2).join("/")}` : parent.join("/");
}

/**
 * The bases' menu: a line to filter them by, then the local and remote branches.
 *
 * @remarks
 * design-language ("新建工作区页"): the line has the focus as the menu opens; what is typed matches
 * any part of a name, in either case. The main branch and the local current one carry a label.
 *
 * @sideEffects Focuses the filter as it appears.
 * @param props - The bases, the base chosen, and what choosing one does.
 * @returns The menu's content.
 */
function BaseMenu({
  bases,
  chosen,
  onChoose,
}: {
  readonly bases: CommandResult<"list_bases">;
  readonly chosen: string | null;
  readonly onChoose: (ref: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const wanted = filter.trim().toLowerCase();
  const groups = (
    [
      ["本地分支", "local", bases.local],
      ["远程分支", "remote", bases.remote],
    ] as const
  ).map(
    ([heading, kind, names]) => [heading, kind, names.filter((name) => name.toLowerCase().includes(wanted))] as const,
  );
  return (
    <>
      <div className="-mx-1 -mt-1 mb-1 flex h-[34px] items-center gap-2 px-3.5 shadow-[inset_0_-0.5px_0_var(--line)]">
        <MagnifyingGlass size={14} className="shrink-0 text-[var(--text-dim)]" />
        <input
          ref={field}
          aria-label="过滤分支"
          placeholder="过滤分支…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[length:var(--fs-meta)] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
        />
      </div>
      {groups.every(([, , names]) => names.length === 0) ? (
        <p className={MENU_HEADING}>没有匹配的分支</p>
      ) : (
        groups.map(([heading, kind, names]) =>
          names.length === 0 ? null : (
            <div key={heading} role="group" aria-label={heading}>
              <p className={MENU_HEADING}>{heading}</p>
              {names.map((name) => (
                <ChoiceItem
                  key={name}
                  icon={<GitBranch size={14} className="shrink-0 text-[var(--text-muted)]" />}
                  name={
                    <>
                      <span className="truncate font-[family-name:var(--font-mono)]">{name}</span>
                      {kind === "remote" && name === bases.main ? (
                        <span className={`${BADGE} bg-[var(--linked)] text-[var(--tint)]`}>主分支</span>
                      ) : null}
                      {kind === "local" && name === bases.current ? (
                        <span className={`${BADGE} bg-[var(--surface-2)] text-[var(--text-muted)]`}>当前</span>
                      ) : null}
                    </>
                  }
                  checked={chosen === baseRef(kind, name)}
                  onChoose={() => onChoose(baseRef(kind, name))}
                />
              ))}
            </div>
          ),
        )
      )}
    </>
  );
}

/**
 * The bases of the page's project, asked for as the page shows it.
 *
 * @remarks
 * Once they arrive, a new worktree with no base chosen starts from the default one; a project that
 * is not a repository goes into its local workspace (SPEC-0001, "M1.11 的新建工作区"). What the
 * answer does is decided from the page as it is then, as the user may have gone on meanwhile.
 *
 * @sideEffects Sends `list_bases`; updates the page's store and component state.
 * @param client - The client.
 * @param store - The page's store.
 * @param projectId - The project.
 * @returns The bases, or `null` while they are on their way.
 */
function useBases(client: AtriumClient, store: StoreApi<NewWorkspaceState>, projectId: string): Bases | null {
  const [bases, setBases] = useState<Bases | null>(null);
  useEffect(() => {
    let current = true;
    /**
     * Keeps what came, and sets the page's base or workspace by it.
     *
     * @remarks
     * See `useBases`.
     *
     * @sideEffects Updates the page's store and component state.
     * @param answer - The bases, or why there are none.
     */
    const arrived = (answer: Bases): void => {
      if (!current) return;
      setBases(answer);
      const page = store.getState().page;
      if (page?.projectId !== projectId || page.choice.kind !== "new") return;
      if (answer.kind === "ready" && page.choice.base === null) {
        choose(store, { choice: { ...page.choice, base: defaultBase(answer.bases) } });
      }
      const local = client.index
        .getState()
        .workspaces.find((one) => one.projectId === projectId && one.kind === "local" && one.archivedAt === null);
      if (answer.kind === "not_git" && local !== undefined) {
        choose(store, { choice: { kind: "existing", workspaceId: local.id } });
      }
    };
    client.listBases(projectId).then(
      (answer) => arrived({ projectId, kind: "ready", bases: answer }),
      (error: unknown) =>
        arrived({
          projectId,
          kind: error instanceof CommandError && error.params?.["reason"] === "not_git" ? "not_git" : "failed",
        }),
    );
    return () => {
      current = false;
    };
  }, [client, store, projectId]);
  return bases?.projectId === projectId ? bases : null;
}

/**
 * The choices above the page's input box: the project, the workspace, and for a new worktree its
 * base and branch.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"), design-language ("新建工作区页"). The workspaces are the
 * project's not archived, the local one first; a project that is not a repository has no new
 * worktree. The branch is edited in place: Enter or leaving the field keeps it, Escape does not.
 * Nothing changes while the first message is on its way.
 *
 * @sideEffects Updates the page's store.
 * @param props - The client, the page's store, the page, its project's bases, and whether the
 * choices are held.
 * @returns The row.
 */
function Choices({
  client,
  store,
  page,
  bases,
  held,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<NewWorkspaceState>;
  readonly page: Page;
  readonly bases: Bases | null;
  readonly held: boolean;
}) {
  const index = useStore(client.index);
  const [editing, setEditing] = useState(false);
  const project = index.projects.find((one) => one.id === page.projectId);
  const workspaces = sortWorkspaces(
    index.workspaces.filter((one) => one.projectId === page.projectId && one.archivedAt === null),
  );
  const { choice } = page;
  const chosen = choice.kind === "existing" ? workspaces.find((one) => one.id === choice.workspaceId) : undefined;
  const notGit = bases?.kind === "not_git";
  const ready = bases?.kind === "ready" ? bases.bases : null;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-wrap items-center gap-1.5 px-6 pb-1.5">
      <MenuButton
        chip
        align="start"
        disabled={held}
        label="项目"
        content={
          <>
            <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />
            <span className="truncate">{project?.name ?? ""}</span>
            <CaretDown size={12} className="shrink-0 text-[var(--text-dim)]" />
          </>
        }
      >
        {(close) =>
          index.projects.map((one) => (
            <ChoiceItem
              key={one.id}
              icon={<Folder size={16} className="shrink-0 text-[var(--text-muted)]" />}
              name={<span className="truncate">{one.name}</span>}
              meta={parentLabel(one.path)}
              title={one.path}
              checked={one.id === page.projectId}
              onChoose={() => {
                close();
                choose(store, { projectId: one.id });
              }}
            />
          ))
        }
      </MenuButton>
      <MenuButton
        chip
        align="start"
        disabled={held}
        label="工作区"
        content={
          <>
            <GitBranch size={14} className="shrink-0 text-[var(--text-muted)]" />
            <span className="truncate">{chosen === undefined ? "新建 worktree" : workspaceName(chosen)}</span>
            <CaretDown size={12} className="shrink-0 text-[var(--text-dim)]" />
          </>
        }
      >
        {(close) => (
          <>
            <ChoiceItem
              icon={<Plus size={16} className="shrink-0 text-[var(--tint)]" />}
              name="新建 worktree"
              checked={choice.kind === "new"}
              disabled={notGit}
              title={notGit ? "这个项目不是 git 仓库" : undefined}
              onChoose={() => {
                close();
                if (choice.kind === "new") return;
                choose(store, {
                  choice: { kind: "new", branch: null, base: ready === null ? null : defaultBase(ready) },
                });
              }}
            />
            {workspaces.length === 0 ? null : <div className="mx-2.5 my-1 h-[0.5px] bg-[var(--line)]" />}
            {workspaces.map((one) => (
              <ChoiceItem
                key={one.id}
                icon={
                  one.kind === "local" ? (
                    <Monitor size={16} className="shrink-0 text-[var(--text-muted)]" />
                  ) : (
                    <GitBranch size={16} className="shrink-0 text-[var(--tint)]" />
                  )
                }
                name={<span className="truncate">{workspaceName(one)}</span>}
                meta={
                  <>
                    {one.merge?.dirty === true ? (
                      <span title="有未提交的改动" className="size-1.5 rounded-full bg-[var(--attn)]" />
                    ) : null}
                    {one.merge !== null && one.merge.ahead > 0 ? (
                      <span className="flex items-center">
                        <ArrowUp size={11} />
                        {one.merge.ahead}
                      </span>
                    ) : null}
                    <span>
                      {index.sessions.filter((session) => session.containerId === one.id && !session.archived).length}{" "}
                      会话
                    </span>
                  </>
                }
                checked={choice.kind === "existing" && choice.workspaceId === one.id}
                onChoose={() => {
                  close();
                  choose(store, { choice: { kind: "existing", workspaceId: one.id } });
                }}
              />
            ))}
          </>
        )}
      </MenuButton>
      {choice.kind === "new" ? (
        <>
          <MenuButton
            chip
            align="start"
            disabled={held}
            label="起点"
            content={
              <>
                <GitCommit size={14} className="shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">基于 {baseName(choice.base ?? "HEAD")}</span>
                <CaretDown size={12} className="shrink-0 text-[var(--text-dim)]" />
              </>
            }
          >
            {(close) =>
              ready === null ? (
                <p className={MENU_HEADING}>{bases === null ? "正在读取分支…" : "读不到分支"}</p>
              ) : (
                <BaseMenu
                  bases={ready}
                  chosen={choice.base}
                  onChoose={(ref) => {
                    close();
                    choose(store, { choice: { ...choice, base: ref } });
                  }}
                />
              )
            }
          </MenuButton>
          {editing ? (
            <span className="flex h-[26px] w-[240px] items-center gap-1.5 px-2 text-[length:var(--fs-meta)]">
              <PencilSimple size={14} className="shrink-0 text-[var(--text-muted)]" />
              <RenameField
                initial={choice.branch ?? ""}
                label="分支名"
                placeholder="输入分支名，留空让 AI 起名"
                restores="清空恢复自动起名"
                above
                onDone={(name) => {
                  setEditing(false);
                  const now = store.getState().page?.choice;
                  // Cleared, the model names it again.
                  if (name !== undefined && now?.kind === "new") choose(store, { choice: { ...now, branch: name } });
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              aria-label="分支名"
              title={choice.branch === null ? "发出后，AI 按第一条消息起分支名；点这里自己写" : "分支名"}
              disabled={held}
              onClick={() => setEditing(true)}
              className="flex h-[26px] max-w-[240px] items-center gap-1.5 whitespace-nowrap rounded-[var(--r-btn)] px-2 text-[length:var(--fs-meta)] text-[var(--text-2)] enabled:hover:bg-[var(--hover)] disabled:text-[var(--text-dim)]"
            >
              {choice.branch === null ? (
                <Sparkle size={14} className="shrink-0 text-[var(--tint)]" />
              ) : (
                <PencilSimple size={14} className="shrink-0 text-[var(--text-muted)]" />
              )}
              <span className="truncate">{choice.branch ?? "自动起名"}</span>
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * The "新建工作区" page: choose where to work, and the first message creates it.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"), laid out as the empty state (design-language, "新建工作区页").
 * Typing creates nothing; sending sets the launch going (`launch`), whose timeline shows at the
 * top until the session exists, when the page gives way to it. The box keeps a draft per project,
 * has no `/` or `@` menu, as there is no session to ask, and sends nothing while the first message
 * is on its way, nor, for a new worktree, before the bases come. The model button shows and chooses the page's model, set on the session before
 * the message; its list is the chosen workspace's, or the local one's for a new worktree. A page
 * whose project went away closes.
 *
 * @sideEffects Subscribes to the page's store and the client's list; asks for the project's bases
 * and models; sends commands when the user sends.
 * @param props - The client and the page's store.
 * @returns The page.
 */
export function NewWorkspacePage({
  client,
  store,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<NewWorkspaceState>;
}) {
  const page = useStore(store, (state) => state.page);
  const going = useStore(store, (state) => state.launches.find((one) => one.id === state.page?.launchId));
  const projectId = page?.projectId ?? "";
  const bases = useBases(client, store, projectId);
  const gone = useStore(client.index, (index) => index.ready && !index.projects.some((one) => one.id === projectId));
  const local = useStore(
    client.index,
    (index) =>
      index.workspaces.find((one) => one.projectId === projectId && one.kind === "local" && one.archivedAt === null)
        ?.id ?? null,
  );
  const modelsOf = page?.choice.kind === "existing" ? page.choice.workspaceId : local;
  const list = useStore(client.models(modelsOf));
  const preferences = useStore(client.index, (index) => index.preferences);
  useEffect(() => {
    // Fire and forget: a failed list shows in the model panel.
    void client.loadModels(modelsOf);
  }, [client, modelsOf]);
  useEffect(() => {
    if (gone) closePage(store);
  }, [gone, store]);
  if (page === null) return null;
  const shown = pageModel(page.model, preferences, list);
  const held = holdsBack(going);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {going === undefined ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-[var(--text-muted)]">
          <p className="text-[20px] font-medium text-[var(--text)]">新建工作区</p>
          <p className="text-[length:var(--fs-meta)]">
            {page.choice.kind === "new"
              ? "发出第一条消息时，才建 worktree"
              : "发出第一条消息时，在这个工作区里新建会话"}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LaunchView launch={going} reason={going.failure === undefined ? null : describeLaunchError(going.failure)} />
        </div>
      )}
      <Choices client={client} store={store} page={page} bases={bases} held={held} />
      <Composer
        key={projectId}
        draftKey={pageDraftKey(projectId)}
        autoFocus
        // Until the bases come, a new worktree would start from HEAD rather than the default one.
        held={held || (page.choice.kind === "new" && bases === null)}
        onSend={(text, images) => {
          // Fire and forget: the launch shows its own failures.
          void launch(store, client, pageDrafts(), { text, images }, () => crypto.randomUUID());
        }}
        onUpload={async (image) => (await client.uploadAttachment(image.mimeType, image.data)).attachmentId}
        imagesAllowed={shown?.supportsImage !== false}
        picker={
          <ModelPicker
            shown={shown}
            list={list}
            disabled={held}
            onOpen={() => {
              // Fire and forget: see above.
              void client.loadModels(modelsOf);
            }}
            onRefresh={() => {
              // Fire and forget: see above.
              void client.loadModels(modelsOf, true);
            }}
            onChooseModel={(ref) => choose(store, { model: { ref, level: null } })}
            onChooseLevel={(level) => choose(store, { model: { ...page.model, level } })}
          />
        }
      />
      {/* Where a session's status bar goes, as in the empty state. */}
      <div aria-hidden="true" className="h-9 shrink-0" />
    </div>
  );
}

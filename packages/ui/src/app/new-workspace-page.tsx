import { type AtriumClient, CommandError } from "@atrium/client";
import type { CommandResult } from "@atrium/protocol";
import { useEffect, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { Composer } from "../chat/composer";
import { describeLaunchError } from "../chat/conversation-area";
import { LaunchView } from "../chat/launch-timeline";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { ModelPicker } from "../chat/model-picker";
import { CaretDown, Folder, GitBranch, GitCommit, PencilSimple } from "../design/icons";
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
  suggestBranch,
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
            <button
              key={one.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                choose(store, { projectId: one.id });
              }}
            >
              {one.name}
            </button>
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
            <button
              type="button"
              role="menuitem"
              disabled={notGit}
              title={notGit ? "这个项目不是 git 仓库" : undefined}
              className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
              onClick={() => {
                close();
                if (choice.kind === "new") return;
                choose(store, {
                  choice: {
                    kind: "new",
                    branch: suggestBranch(Math.random),
                    base: ready === null ? null : defaultBase(ready),
                  },
                });
              }}
            >
              新建 worktree
            </button>
            {workspaces.map((one) => (
              <button
                key={one.id}
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  choose(store, { choice: { kind: "existing", workspaceId: one.id } });
                }}
              >
                {workspaceName(one)}
              </button>
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
                (
                  [
                    ["本地分支", "local", ready.local],
                    ["远程分支", "remote", ready.remote],
                  ] as const
                ).map(([heading, kind, names]) =>
                  names.length === 0 ? null : (
                    <div key={heading} role="group" aria-label={heading}>
                      <p className={MENU_HEADING}>{heading}</p>
                      {names.map((name) => (
                        <button
                          key={name}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => {
                            close();
                            choose(store, { choice: { ...choice, base: baseRef(kind, name) } });
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  ),
                )
              )
            }
          </MenuButton>
          {editing ? (
            <span className="flex h-[26px] w-[240px] items-center">
              <RenameField
                initial={choice.branch}
                label="分支名"
                onDone={(name) => {
                  setEditing(false);
                  const now = store.getState().page?.choice;
                  if (typeof name === "string" && now?.kind === "new")
                    choose(store, { choice: { ...now, branch: name } });
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              aria-label="分支名"
              title="分支名"
              disabled={held}
              onClick={() => setEditing(true)}
              className="flex h-[26px] max-w-[240px] items-center gap-1.5 whitespace-nowrap rounded-[var(--r-btn)] px-2 text-[length:var(--fs-meta)] text-[var(--text-2)] enabled:hover:bg-[var(--hover)] disabled:text-[var(--text-dim)]"
            >
              <PencilSimple size={14} className="shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{choice.branch}</span>
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

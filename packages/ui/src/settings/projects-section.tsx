import { type AtriumClient, CommandError } from "@atrium/client";
import type { Project } from "@atrium/protocol";
import { CaretDown, Folder } from "../design/icons";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { Group, LINK_BUTTON, Row, Tick } from "./parts";

/** A project's branches on `origin`, as far as asked. */
type Branches =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly branches: readonly string[]; readonly head: string | null };

/**
 * The settings' projects: each project's main branch.
 *
 * @remarks
 * SPEC-0001 ("设置 · 项目"): "自动" follows `origin/HEAD`, shown beside it; a branch on `origin`
 * can be chosen instead, and "恢复自动" goes back. Without either, the merge state cannot be told.
 * Adding and removing projects stay in the sidebar.
 *
 * @sideEffects Subscribes to the client's list; asks the host for each project's branches when
 * shown; sends `set_main_branch` when one is chosen.
 * @param props - The client.
 * @returns The section.
 */
export function ProjectsSection({ client }: { readonly client: AtriumClient }) {
  const projects = useStore(client.index, (index) => index.projects);
  return (
    <Group
      title="主干分支"
      description={
        <>
          主干用来判断 worktree 合没合并，也是胶囊条里"+A −D"的比较基准。默认取 <Code>origin/HEAD</Code>{" "}
          指向的分支，比较时用本机的这个分支，本机没有时用 <Code>origin/&lt;主干&gt;</Code>。
        </>
      }
      footer="改了之后，这个项目下所有 worktree 的合并状态和 +A −D 会重新计算。"
    >
      {projects.length === 0 ? (
        <p className="px-3 text-[length:var(--fs-meta)] text-[var(--text-muted)]">还没有项目，在侧栏里添加。</p>
      ) : (
        projects.map((project) => <ProjectRow key={project.id} client={client} project={project} />)
      )}
    </Group>
  );
}

/**
 * A bit of code in running text.
 *
 * @remarks
 * Branch names and paths in the settings' explanations.
 *
 * @sideEffects none
 * @param props - The code.
 * @returns The element.
 */
function Code({ children }: { readonly children: string }) {
  return (
    <code className="rounded-[4px] bg-[var(--selected)] px-1 font-mono text-[11.5px] text-[var(--text-3)]">
      {children}
    </code>
  );
}

/**
 * One project's main branch.
 *
 * @remarks
 * See `ProjectsSection`. A refused choice says why under the path; the list changes once the
 * host takes it.
 *
 * @sideEffects Asks the host for the project's branches when shown; sends `set_main_branch`.
 * @param props - The client and the project.
 * @returns The row.
 */
function ProjectRow({ client, project }: { readonly client: AtriumClient; readonly project: Project }) {
  const [branches, setBranches] = useState<Branches>({ status: "loading" });
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let shown = true;
    /**
     * Asks for the project's branches and shows them, unless the row went away meanwhile.
     *
     * @remarks
     * See `ProjectRow`.
     *
     * @sideEffects Sends `list_branches`; sets component state.
     */
    const load = async (): Promise<void> => {
      try {
        const { branches: names, head } = await client.listBranches(project.id);
        if (shown) setBranches({ status: "ready", branches: names, head });
      } catch {
        if (shown) setBranches({ status: "failed" });
      }
    };
    // Fire and forget: `load` shows its own failure.
    void load();
    return () => {
      shown = false;
    };
  }, [client, project.id]);

  /**
   * Chooses the main branch, or `null` for "自动".
   *
   * @remarks
   * See `ProjectRow`.
   *
   * @sideEffects Sends `set_main_branch`; may set the problem line.
   * @param branch - The branch.
   */
  const choose = (branch: string | null): void => {
    setProblem(null);
    // Fire and forget: the failure is shown.
    void client.setMainBranch(project.id, branch).catch((error: unknown) => {
      setProblem(
        error instanceof CommandError && error.code === "branch_not_found"
          ? `origin 上没有 ${branch ?? ""} 这个分支了`
          : "没改成，稍后再试",
      );
    });
  };

  const head = branches.status === "ready" ? branches.head : null;
  const chosen = project.mainBranch;
  return (
    <Row
      lead={
        <span className="inline-flex w-8 shrink-0 justify-center text-[var(--text-muted)]">
          <Folder size={20} />
        </span>
      }
      label={project.name}
      detail={
        <>
          <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">{project.path}</span>
          {chosen === null && branches.status === "ready" && head === null ? (
            <span className="text-[var(--attn-text)]">找不到主干，worktree 的合并状态显示为未知</span>
          ) : null}
          {problem === null ? null : (
            <span role="alert" className="text-[var(--danger)]">
              {problem}
            </span>
          )}
        </>
      }
      controls={
        <>
          {chosen === null ? null : (
            <button type="button" className={LINK_BUTTON} onClick={() => choose(null)}>
              恢复自动
            </button>
          )}
          <MenuButton
            field
            label={`${project.name} 的主干分支`}
            content={
              <>
                {chosen === null ? (
                  <>
                    <span>自动</span>
                    <span className="text-[var(--text-dim)]">
                      {branches.status === "ready"
                        ? head === null
                          ? "没有 origin/HEAD"
                          : `origin/HEAD：${head}`
                        : branches.status === "loading"
                          ? "正在读取…"
                          : "读不到分支"}
                    </span>
                  </>
                ) : (
                  <span className="truncate font-mono text-[length:var(--fs-sm)]">{chosen}</span>
                )}
                <CaretDown size={11} className="text-[var(--text-dim)]" />
              </>
            }
          >
            {(close) => (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                  {project.name} 的主干分支
                </div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={chosen === null}
                  className={MENU_ITEM}
                  onClick={() => {
                    close();
                    if (chosen !== null) choose(null);
                  }}
                >
                  <Tick on={chosen === null} />
                  <span className="min-w-0 flex-1">
                    自动
                    <small className="block text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                      {head === null ? "这个仓库没有 origin/HEAD" : `跟随 origin/HEAD，现在是 ${head}`}
                    </small>
                  </span>
                </button>
                <div className="mx-1.5 my-1 h-[0.5px] bg-[var(--line)]" />
                {branches.status === "ready" ? (
                  branches.branches.length === 0 ? (
                    <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                      origin 上没有分支
                    </div>
                  ) : (
                    branches.branches.map((branch) => (
                      <button
                        key={branch}
                        type="button"
                        role="menuitemradio"
                        aria-checked={chosen === branch}
                        className={MENU_ITEM}
                        onClick={() => {
                          close();
                          if (chosen !== branch) choose(branch);
                        }}
                      >
                        <Tick on={chosen === branch} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-sm)]">{branch}</span>
                        {branch === head ? (
                          <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">origin/HEAD</span>
                        ) : null}
                      </button>
                    ))
                  )
                ) : (
                  <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                    {branches.status === "loading" ? "正在读取…" : "读不到 origin 上的分支"}
                  </div>
                )}
              </>
            )}
          </MenuButton>
        </>
      }
    />
  );
}

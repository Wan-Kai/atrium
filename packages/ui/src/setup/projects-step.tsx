import type { AtriumClient } from "@atrium/client";
import type { DiscoveredDirectory } from "@atrium/protocol";
import { Check, FolderPlus } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { describeProjectError } from "../sidebar/sidebar";
import { timeAgo } from "../sidebar/names";
import { useClock } from "../state/clock";
import { EnterHint, FOOT_GHOST, FOOT_PRIMARY, FootSpinner, StepLayout } from "./step-layout";

/** A folder offered on step 3: found in pi's sessions, or chosen just now (no sessions). */
interface Offered {
  readonly path: string;
  readonly found: DiscoveredDirectory | null;
}

/**
 * A path's last part, as a folder's name.
 *
 * @remarks
 * Paths come from the host, absolute and without a trailing slash.
 *
 * @sideEffects none
 * @param path - The path.
 * @returns The name.
 */
function folderName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * Step 3: add projects, dropped, chosen, or picked from the folders of pi's past sessions.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 3 步"): a large drop zone that also opens the folder picker, then the
 * working directories found in pi's sessions with their session count and last use, ticked to
 * add. A folder dropped or chosen joins the top of the list, ticked. The most recently used found
 * folder starts ticked (2026-10-11 定). "添加 N 个项目" adds the ticked folders one by one and
 * finishes once all are in; those that fail stay with the reason. "先新建一个对话" skips adding and
 * starts a chat.
 *
 * @sideEffects Asks the host for the folders of pi's sessions on mount; sends `add_project` and
 * `create_chat` when asked; may open the folder picker.
 * @param props - The client, whether the step was reached going back, how to choose a folder and
 * how to read a dropped folder's path (neither outside the desktop app), finishing, and going back.
 * @returns The step, as the window's middle and bottom rows.
 */
export function ProjectsStep({
  client,
  back,
  pickDirectory,
  pathForFile,
  onDone,
  onBack,
}: {
  readonly client: AtriumClient;
  readonly back: boolean;
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly pathForFile: ((file: File) => string | null) | undefined;
  readonly onDone: () => void;
  readonly onBack: () => void;
}) {
  const now = useClock().now();
  const [offered, setOffered] = useState<readonly Offered[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    /**
     * Offers the folders of pi's sessions, the most recent ticked.
     *
     * @remarks
     * Folders chosen before the answer stay on top. Without an answer only the drop zone shows.
     *
     * @sideEffects Sends `discover_projects`; updates the step's state unless unmounted.
     */
    async function discover(): Promise<void> {
      try {
        const { directories } = await client.discoverProjects();
        if (!active) return;
        setOffered((before) => [
          ...before,
          ...directories
            .filter((one) => !before.some((had) => had.path === one.path))
            .map((one) => ({ path: one.path, found: one })),
        ]);
        const first = directories[0];
        if (first !== undefined) setTicked((before) => new Set([...before, first.path]));
      } catch {
        // Only the drop zone shows.
      }
    }

    // Fire and forget: see above.
    void discover();
    return () => {
      active = false;
    };
  }, [client]);

  /**
   * Offers folders chosen or dropped, ticked, at the top.
   *
   * @remarks
   * A folder offered already is only ticked.
   *
   * @sideEffects Updates the step's state.
   * @param paths - The folders.
   */
  const offer = (paths: readonly string[]): void => {
    setProblem(null);
    setOffered((before) => [
      ...paths.filter((path) => !before.some((had) => had.path === path)).map((path) => ({ path, found: null })),
      ...before,
    ]);
    setTicked((before) => new Set([...before, ...paths]));
  };

  /**
   * Offers the folder chosen in the picker.
   *
   * @remarks
   * Choosing none offers nothing.
   *
   * @sideEffects Opens the folder picker; updates the step's state.
   */
  const choose = async (): Promise<void> => {
    const path = (await pickDirectory?.()) ?? null;
    if (path !== null) offer([path]);
  };

  /**
   * Adds the ticked folders one by one, finishing once all are in.
   *
   * @remarks
   * See `ProjectsStep`. A folder added leaves the list; the first failure is shown.
   *
   * @sideEffects Sends `add_project`; updates the step's state; may finish first launch.
   */
  const add = async (): Promise<void> => {
    setAdding(true);
    setProblem(null);
    let failure: string | null = null;
    for (const { path } of offered.filter((one) => ticked.has(one.path))) {
      try {
        await client.addProject(path);
        setOffered((before) => before.filter((one) => one.path !== path));
        setTicked((before) => new Set([...before].filter((one) => one !== path)));
      } catch (error) {
        failure ??= `${folderName(path)}：${describeProjectError(error, client.index.getState().projects)}`;
      }
    }
    setAdding(false);
    if (failure === null) onDone();
    else setProblem(failure);
  };

  const count = offered.filter((one) => ticked.has(one.path)).length;
  return (
    <StepLayout
      screen="projects"
      back={back}
      eyebrow="第 3 步 · 添加项目"
      title="从一个项目开始"
      lead="选一个代码目录，agent 会在里面读写代码。以后随时可以再加。"
      footer={
        <>
          <button type="button" className={FOOT_GHOST} onClick={onBack}>
            返回
          </button>
          <button
            type="button"
            className={FOOT_GHOST}
            onClick={() => {
              // Fire and forget: the chat opens in the workbench; a failure shows there on the next send.
              void client.createChat().catch(() => undefined);
              onDone();
            }}
          >
            先新建一个对话
          </button>
          <span className="flex-1" />
          <button
            type="button"
            data-enter
            disabled={count === 0 || adding}
            className={FOOT_PRIMARY}
            onClick={() => void add()}
          >
            {adding ? <FootSpinner /> : null}
            {adding ? "正在添加" : count === 0 ? "添加项目" : `添加 ${count} 个项目`}
            {adding ? null : <EnterHint />}
          </button>
        </>
      }
    >
      <button
        type="button"
        disabled={pickDirectory === undefined}
        data-over={over ? "" : undefined}
        onClick={() => {
          // Fire and forget: a picker that fails offers nothing.
          void choose().catch(() => undefined);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const paths = [...event.dataTransfer.files].flatMap((file) => {
            const path = pathForFile?.(file) ?? "";
            return path === "" ? [] : [path];
          });
          if (paths.length > 0) offer(paths);
        }}
        className="group flex h-[150px] w-full flex-col items-center justify-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed border-[var(--line-strong)] text-[var(--text-muted)] transition-colors duration-200 hover:border-[var(--tint)] hover:bg-[var(--linked)] hover:text-[var(--tint)] data-over:border-[var(--tint)] data-over:bg-[var(--linked)] data-over:text-[var(--tint)] disabled:hover:border-[var(--line-strong)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
      >
        <FolderPlus size={26} />
        <b className="mt-1 font-medium text-[var(--text-2)] group-hover:text-[var(--tint)] group-data-over:text-[var(--tint)] group-disabled:group-hover:text-[var(--text-2)]">
          把项目文件夹拖到这里
        </b>
        <span className="text-[12.5px]">或者点击选择</span>
      </button>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-center text-[length:var(--fs-sm)] text-[var(--danger)]">
          {problem}
        </p>
      )}
      {offered.length === 0 ? null : (
        <div role="group" aria-label="要添加的文件夹" className="mt-[18px]">
          {offered.some((one) => one.found !== null) ? (
            <div className="px-1.5 pb-2 text-[12.5px] text-[var(--text-muted)]">在 pi 的历史会话里找到</div>
          ) : null}
          {offered.map(({ path, found }) => {
            const on = ticked.has(path);
            return (
              <button
                key={path}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={folderName(path)}
                onClick={() =>
                  setTicked((before) => {
                    const next = new Set(before);
                    if (on) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                className="flex h-[54px] w-full items-center gap-3 rounded-[12px] px-3 text-left hover:bg-[var(--hover)]"
              >
                <span
                  className={`grid size-[18px] shrink-0 place-items-center rounded-[6px] transition-all duration-200 ${
                    on
                      ? "bg-[var(--onb-primary)] text-[var(--onb-on-primary)]"
                      : "shadow-[inset_0_0_0_1.5px_var(--line-strong)]"
                  }`}
                >
                  {on ? <Check size={11} weight="bold" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <b className="block font-medium">{folderName(path)}</b>
                  <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">{path}</span>
                </span>
                <span className="text-[length:var(--fs-sm)] whitespace-nowrap text-[var(--text-dim)]">
                  {found === null ? "刚选的" : `${found.sessions} 个会话 · ${timeAgo(found.lastUsedAt, now)}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </StepLayout>
  );
}

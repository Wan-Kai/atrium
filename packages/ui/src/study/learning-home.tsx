import type { AtriumClient } from "@atrium/client";
import type { Direction } from "@atrium/protocol";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { DotsThree, Pin, Plus } from "../design/icons";
import { BUTTON, PRIMARY_BUTTON } from "../settings/parts";
import { DirectionArchiveDialog } from "../sidebar/archive";
import { MORE_ROW } from "../sidebar/more-row";
import { RenameField } from "../sidebar/rename-field";
import {
  type LearningState,
  closeLearning,
  continueDirection,
  describeStudyError,
  directionName,
  directionStage,
  listedDirections,
  openLearning,
  showHome,
} from "./learning";

/** The class of a section's heading on the learning home. */
const HEADING = "mb-2.5 flex items-center gap-2 text-[length:var(--fs-meta)] font-medium text-[var(--text-muted)]";

/**
 * Runs a learning-home command, showing its failure on the page.
 *
 * @remarks
 * The page has no other place to report.
 *
 * @sideEffects Runs the command; may set the problem.
 * @param command - The command.
 * @param fail - Where its failure goes.
 */
function run(command: () => Promise<unknown>, fail: (problem: string | null) => void): void {
  fail(null);
  // Fire and forget: the failure is shown.
  void command().catch((error: unknown) => fail(describeStudyError(error)));
}

/**
 * Goes into a direction, its home tab shown.
 *
 * @remarks
 * Clicking a direction on the learning home opens its home (design-language, "学习模式").
 *
 * @sideEffects Sends `select_container`; updates the study store.
 * @param client - The client.
 * @param store - The study store.
 * @param directionId - The direction.
 * @returns When the host answered.
 */
async function goInto(client: AtriumClient, store: StoreApi<LearningState>, directionId: string): Promise<unknown> {
  closeLearning(store);
  showHome(store, directionId, true);
  return client.selectContainer(directionId);
}

/**
 * The learning home: "继续", every direction's card, "新建方向", and the archived ones.
 *
 * @remarks
 * SPEC-0008 ("入口"), design-language ("学习模式"; prototype screens 1 and 14). Without a
 * direction it is the empty state with "新建方向". In ML1 every direction is under discussion,
 * so a card says so; levels, steps and gaps come in ML2 and ML4. A card opens the direction's
 * home, where its sessions are; there is no "继续讨论" (SPEC-0008, "ML1 定的细节"). Its "···"
 * pins, renames in place and archives it; archiving asks only when some of its sessions run, as
 * nothing else is lost (its directory moves under `Archive/`). The archived directions are listed
 * last, each with "恢复"; clicking one opens its home. A failure shows above the cards until the
 * next action.
 *
 * @sideEffects Subscribes to the list; sends commands and updates the study store when used.
 * @param props - The client and the study store.
 * @returns The page.
 */
export function LearningHome({
  client,
  store,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
}) {
  const directions = useStore(client.index, (index) => index.directions);
  const learningDir = useStore(client.index, (index) => index.learningDir);
  const sessions = useStore(client.index, (index) => index.sessions);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<{ readonly direction: Direction; readonly running: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const listed = listedDirections(directions);
  const archived = directions.filter((direction) => direction.archived);
  const resume = continueDirection(directions);

  if (listed.length === 0 && archived.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-center">
        <p className="text-[20px] font-semibold text-[var(--text)]">想学点什么？</p>
        <p className="mb-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          一个方向一个目录，放在 {learningDir}/ 下面
        </p>
        <button type="button" className={PRIMARY_BUTTON} onClick={() => openLearning(store, "new")}>
          <Plus size={14} />
          新建方向
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[var(--column)] px-6 py-6">
        {problem === null ? null : (
          <p role="alert" className="mb-3 text-[length:var(--fs-sm)] text-[var(--danger)]">
            {problem}
          </p>
        )}
        {resume === undefined ? null : (
          <section aria-label="继续" className="mb-6">
            <h2 className={HEADING}>继续</h2>
            <div className="rounded-[14px] bg-[var(--surface-1)] px-5 pt-[18px] pb-4 shadow-[var(--card-shadow)]">
              <p className="text-[length:var(--fs-sm)] font-semibold text-[var(--tint)]">{directionName(resume)}</p>
              <p className="mt-1.5 mb-1 text-[17px] font-semibold text-[var(--text)]">{directionStage(resume).stage}</p>
              <p className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">{directionStage(resume).line}</p>
              <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  onClick={() => run(() => goInto(client, store, resume.id), setProblem)}
                >
                  打开 {directionName(resume)}
                </button>
              </div>
            </div>
          </section>
        )}
        <section aria-label="全部方向">
          <h2 className={HEADING}>
            <span className="flex-1">全部方向</span>
            <button type="button" className={BUTTON} onClick={() => openLearning(store, "new")}>
              <Plus size={14} />
              新建方向
            </button>
          </h2>
          <div className="grid grid-cols-2 gap-2.5">
            {listed.map((direction) => (
              <DirectionTile
                key={direction.id}
                direction={direction}
                renaming={renaming === direction.id}
                onOpen={() => run(() => goInto(client, store, direction.id), setProblem)}
                onPin={() =>
                  run(
                    () =>
                      direction.pinnedAt === null
                        ? client.pinDirection(direction.id)
                        : client.unpinDirection(direction.id),
                    setProblem,
                  )
                }
                onRename={() => setRenaming(direction.id)}
                onRenamed={(name) => {
                  setRenaming(null);
                  if (name === undefined) return;
                  run(() => client.renameDirection(direction.id, name), setProblem);
                }}
                onArchive={() => {
                  const running = sessions.filter(
                    (session) => session.containerId === direction.id && !session.archived && session.running,
                  ).length;
                  if (running > 0) setArchiving({ direction, running });
                  else run(() => client.archiveDirection(direction.id), setProblem);
                }}
              />
            ))}
            <button
              type="button"
              onClick={() => openLearning(store, "new")}
              className="grid min-h-[86px] place-items-center content-center gap-0.5 rounded-[14px] text-[var(--text-muted)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
            >
              <Plus size={16} />
              <span className="text-[length:var(--fs-sm)]">新建方向</span>
            </button>
          </div>
        </section>
        {archiving === null ? null : (
          <DirectionArchiveDialog
            name={directionName(archiving.direction)}
            learningDir={learningDir}
            running={archiving.running}
            onArchive={() => run(() => client.archiveDirection(archiving.direction.id), setProblem)}
            onClose={() => setArchiving(null)}
          />
        )}
        {archived.length === 0 ? null : (
          <section aria-label="已归档的方向" className="mt-5">
            <button
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(!archivedOpen)}
              className={MORE_ROW}
            >
              已归档的方向
            </button>
            {archivedOpen ? (
              <ul aria-label="已归档的方向" className="max-h-64 overflow-y-auto">
                {archived.map((direction) => {
                  const name = directionName(direction);
                  return (
                    <li key={direction.id} className="flex h-8 items-center gap-2 rounded-[var(--r)] pr-1 pl-2.5">
                      <button
                        type="button"
                        onClick={() => run(() => goInto(client, store, direction.id), setProblem)}
                        className="min-w-0 truncate text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:text-[var(--text)]"
                      >
                        {name}
                      </button>
                      <button
                        type="button"
                        aria-label={`恢复 ${name}`}
                        className="ml-auto shrink-0 rounded-[var(--r)] px-1.5 py-0.5 text-[length:var(--fs-meta)] text-[var(--tint)] hover:bg-[var(--hover)]"
                        onClick={() => run(() => client.restoreDirection(direction.id), setProblem)}
                      >
                        恢复
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * One direction's card on the learning home.
 *
 * @remarks
 * design-language ("学习模式"): `--surface-1`, 14px corners, `--card-shadow`, 12px 14px inside;
 * the name at `--fs` 500, a pin before it when pinned, "讨论中" after it; below, what it is at.
 * The whole card opens the direction (SPEC-0008, "ML1 定的细节"); its "···" pins, renames and
 * archives. A broken marker says so (provisional wording, ML1).
 *
 * @sideEffects none; the callbacks send commands.
 * @param props - The direction, whether it is being renamed, and what each action does.
 * @returns The card.
 */
function DirectionTile({
  direction,
  renaming,
  onOpen,
  onPin,
  onRename,
  onRenamed,
  onArchive,
}: {
  readonly direction: Direction;
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onPin: () => void;
  readonly onRename: () => void;
  readonly onRenamed: (name: string | null | undefined) => void;
  readonly onArchive: () => void;
}) {
  const name = directionName(direction);
  return (
    <div
      role="group"
      aria-label={name}
      className="relative rounded-[14px] bg-[var(--surface-1)] px-3.5 py-3 text-[length:var(--fs-meta)] shadow-[var(--card-shadow)] hover:bg-[var(--hover)]"
    >
      {renaming ? null : (
        // The whole card opens the direction; the name's button is what a keyboard and a reader reach.
        <span aria-hidden className="absolute inset-0 cursor-default rounded-[14px]" onClick={onOpen} />
      )}
      <div className="flex items-center gap-2 pr-7 text-[length:var(--fs)] font-medium text-[var(--text)]">
        {direction.pinnedAt === null ? null : (
          <Pin size={13} aria-label="已置顶" className="shrink-0 text-[var(--tint)]" />
        )}
        {renaming ? (
          <RenameField initial={name} label="方向名称" restores={direction.name} onDone={onRenamed} />
        ) : (
          <button type="button" onClick={onOpen} className="relative min-w-0 truncate text-left">
            {name}
          </button>
        )}
        {direction.discussing || direction.broken ? (
          <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--attn-soft)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--attn-text)]">
            讨论中
          </span>
        ) : null}
      </div>
      <p className="mt-[3px] text-[length:var(--fs-sm)] text-[var(--text-muted)]">{directionStage(direction).line}</p>
      <span className="absolute top-2 right-2">
        <MenuButton label={`${name} 的更多操作`} compact content={<DotsThree size={14} />}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  onPin();
                }}
              >
                {direction.pinnedAt === null ? "置顶" : "取消置顶"}
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  onRename();
                }}
              >
                改名
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  onArchive();
                }}
              >
                归档
              </button>
            </>
          )}
        </MenuButton>
      </span>
    </div>
  );
}

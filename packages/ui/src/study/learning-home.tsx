import type { AtriumClient } from "@atrium/client";
import type { Direction, SessionSummary, StudyAction } from "@atrium/protocol";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { Award, CaretRight, DotsThree, Pin, Plus, Warning } from "../design/icons";
import { BUTTON, PRIMARY_BUTTON } from "../settings/parts";
import { DirectionArchiveDialog } from "../sidebar/archive";
import { MORE_ROW } from "../sidebar/more-row";
import { RenameField } from "../sidebar/rename-field";
import { useClock } from "../state/clock";
import { type WorkspaceViews, showViewer } from "../state/workspace-views";
import { archivedDirections, archivedLine, continueCard, directionCard } from "./home-view";
import {
  type LearningState,
  closeLearning,
  continueDirection,
  describeStudyError,
  directionName,
  listedDirections,
  openLearning,
  showHome,
} from "./learning";
import { actionLabel } from "./progress";
import { StepDots } from "./step-dots";
import { blockedBecause, runAction } from "./step-strip";
import { StudyIcon } from "./study-icon";
import { isLastLevel } from "./loop";

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
 * Clicking a direction on the learning home opens its home (design-language, "学习模式"), over a
 * viewer tab left open in it too (ML4 three-way review).
 *
 * @sideEffects Sends `select_container`; updates the study store and the views.
 * @param client - The client.
 * @param store - The study store.
 * @param views - The workspace views.
 * @param directionId - The direction.
 * @returns When the host answered.
 */
async function goInto(
  client: AtriumClient,
  store: StoreApi<LearningState>,
  views: StoreApi<WorkspaceViews>,
  directionId: string,
): Promise<unknown> {
  closeLearning(store);
  showViewer(views, directionId, null);
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
 * @sideEffects Subscribes to the list; sends commands and updates the study store and the views
 * when used.
 * @param props - The client, the study store and the workspace views.
 * @returns The page.
 */
export function LearningHome({
  client,
  store,
  views,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  /** The workspace views: going into a direction shows what was asked for over its viewer tab. */
  readonly views: StoreApi<WorkspaceViews>;
}) {
  const directions = useStore(client.index, (index) => index.directions);
  const learningDir = useStore(client.index, (index) => index.learningDir);
  const sessions = useStore(client.index, (index) => index.sessions);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<{ readonly direction: Direction; readonly running: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const listed = listedDirections(directions);
  const archived = archivedDirections(directions);
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
          <ContinueSection
            key={resume.id}
            client={client}
            store={store}
            views={views}
            direction={resume}
            sessions={sessions}
            onProblem={setProblem}
          />
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
                sessions={sessions}
                renaming={renaming === direction.id}
                onOpen={() => run(() => goInto(client, store, views, direction.id), setProblem)}
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
          <section aria-label="已归档的方向" className="mt-[18px]">
            <button
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(!archivedOpen)}
              className={`${MORE_ROW} gap-1.5`}
            >
              <CaretRight size={12} aria-hidden className={archivedOpen ? "rotate-90" : ""} />
              已归档的方向
              <span aria-hidden className="text-[var(--text-dim)]">
                {archived.length}
              </span>
            </button>
            {archivedOpen ? (
              <ul aria-label="已归档的方向" className="max-h-64 overflow-y-auto pl-1">
                {archived.map((direction) => {
                  const name = directionName(direction);
                  return (
                    <li
                      key={direction.id}
                      className="group flex h-8 items-center gap-2.5 rounded-[var(--r)] pr-2 pl-2.5 whitespace-nowrap hover:bg-[var(--hover)] focus-within:bg-[var(--hover)]"
                    >
                      <button
                        type="button"
                        onClick={() => run(() => goInto(client, store, views, direction.id), setProblem)}
                        className="min-w-0 truncate text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:text-[var(--text)]"
                      >
                        {name}
                      </button>
                      <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                        {archivedLine(direction)}
                      </span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        aria-label={`恢复 ${name}`}
                        className="shrink-0 rounded-[var(--r)] px-1 text-[length:var(--fs-sm)] text-[var(--tint)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
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

/** The continue card's 30px buttons, as the direction home's (design-language "学习模式", 1C). */
const CARD_BUTTON =
  "inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[12px] px-3 text-[length:var(--fs-meta)] whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-[0.42]";
/** The filled look of the primary button. */
const FILLED = "bg-[var(--tint)] font-semibold text-[var(--on-tint)] hover:opacity-90";

/**
 * Runs the continue card's primary as the strip runs it, going into the direction first.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 继续" (2026-11-10 A): a start opens its session, then the window goes
 * into the direction where it shows; going back opens it; the upgrade asks on the direction's home;
 * "进入下一步" is marked from here, and the card then shows the next step. A start refused stays on
 * the learning home, which says why.
 *
 * @sideEffects Sends commands; updates the study store and the views.
 * @param client - The client.
 * @param store - The study store.
 * @param views - The workspace views.
 * @param directionId - The direction.
 * @param action - The strip's primary.
 * @returns When the host answered.
 */
async function continueWith(
  client: AtriumClient,
  store: StoreApi<LearningState>,
  views: StoreApi<WorkspaceViews>,
  directionId: string,
  action: StudyAction,
): Promise<void> {
  if (action.type === "upgrade") await goInto(client, store, views, directionId);
  await runAction(client, store, directionId, action, views);
  // The session the host opened shows once the window is in its direction; a refusal stays here.
  if (action.type === "start") {
    closeLearning(store);
    await client.selectContainer(directionId);
  }
}

/**
 * The learning home's "继续": the direction opened last and its next step.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 继续"; design-language "学习模式" (prototype study-home 1C): the
 * eyebrow, the big words, a line for a broken or newer file, the strip's dots, then the strip's
 * primary and "打开 方向名", and "上次：…" at the right. Without a primary "打开" is drawn as one.
 * Both wait while a press is under way; a refusal shows above the cards.
 *
 * @sideEffects none; pressing sends commands.
 * @param props - The client, the study store, the views, the direction, every session and where a
 * problem goes.
 * @returns The section.
 */
function ContinueSection({
  client,
  store,
  views,
  direction,
  sessions,
  onProblem,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly views: StoreApi<WorkspaceViews>;
  readonly direction: Direction;
  readonly sessions: readonly SessionSummary[];
  readonly onProblem: (problem: string | null) => void;
}) {
  const now = useClock().now();
  const [busy, setBusy] = useState(false);
  const card = continueCard(direction, sessions, now);
  const name = directionName(direction);
  const { primary } = card;
  const mine = sessions.filter((session) => session.containerId === direction.id);
  const blocked = primary === null ? null : blockedBecause(primary, mine);
  const last =
    direction.progress !== null && primary?.type === "upgrade" && isLastLevel(direction.progress, primary.level);
  /**
   * Runs a press, both buttons waiting meanwhile.
   *
   * @remarks
   * See `ContinueSection`.
   *
   * @sideEffects Sends commands; sets the problem.
   * @param command - What the press does.
   */
  const press = (command: () => Promise<unknown>): void => {
    onProblem(null);
    setBusy(true);
    // Fire and forget: the failure is shown above the cards.
    void command()
      .catch((error: unknown) => onProblem(describeStudyError(error)))
      .finally(() => setBusy(false));
  };
  return (
    <section aria-label="继续" className="mb-6">
      <h2 className={HEADING}>继续</h2>
      <div className="rounded-[16px] bg-[var(--surface-1)] px-5 pt-[18px] pb-4 shadow-[var(--card-shadow)]">
        <p
          className={`flex items-center gap-[5px] text-[length:var(--fs-sm)] font-semibold ${card.warn ? "text-[var(--attn-text)]" : "text-[var(--tint)]"}`}
        >
          {card.warn ? <Warning size={13} aria-hidden /> : null}
          {card.eyebrow}
        </p>
        <p className="mt-1.5 mb-0.5 text-[17px] font-semibold text-[var(--text)]">{card.big}</p>
        {card.desc === null ? null : (
          <p className="text-[length:var(--fs-meta)] leading-[1.6] text-[var(--text-muted)]">{card.desc}</p>
        )}
        {card.dots === null ? null : (
          <div className="mt-2.5 flex">
            <StepDots dots={card.dots} />
          </div>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
          {primary === null ? null : primary.type === "open" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => press(() => continueWith(client, store, views, direction.id, primary))}
              className={`${CARD_BUTTON} font-medium text-[var(--tint)] shadow-[inset_0_0_0_1px_var(--tint)] hover:bg-[var(--linked)]`}
            >
              {card.running ? (
                <span role="img" aria-label="在跑" className="size-[7px] shrink-0 rounded-full bg-[var(--ok)]" />
              ) : null}
              <span>{actionLabel(primary)}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || blocked !== null}
              title={blocked || undefined}
              onClick={() => press(() => continueWith(client, store, views, direction.id, primary))}
              className={`${CARD_BUTTON} ${FILLED}`}
            >
              {primary.type === "upgrade" ? (
                <Award size={13} aria-hidden />
              ) : primary.type === "start" ? (
                <StudyIcon kind={primary.kind} size={13} />
              ) : null}
              {actionLabel(primary, last)}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => press(() => goInto(client, store, views, direction.id))}
            className={`${CARD_BUTTON} ${primary === null ? FILLED : "text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"}`}
          >
            打开 {name}
          </button>
          {card.last === null ? null : (
            <span className="ml-auto text-[length:var(--fs-sm)] whitespace-nowrap text-[var(--text-dim)]">
              {card.last}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One direction's card on the learning home.
 *
 * @remarks
 * design-language ("学习模式"): `--surface-1`, 14px corners, `--card-shadow`, 12px 14px inside;
 * the name at `--fs` 500, a pin before it when pinned, after it the running dot or "待回答" and
 * "讨论中"; below, where it stands, then the current level's dots at 6px (prototype study-home 2A,
 * SPEC-0008 "ML4 定的细节 · 方向卡片"). The whole card opens the direction (SPEC-0008, "ML1 定的细节");
 * its "···" pins, renames and archives.
 *
 * @sideEffects none; the callbacks send commands.
 * @param props - The direction, every session, whether it is being renamed, and what each action does.
 * @returns The card.
 */
function DirectionTile({
  direction,
  sessions,
  renaming,
  onOpen,
  onPin,
  onRename,
  onRenamed,
  onArchive,
}: {
  readonly direction: Direction;
  readonly sessions: readonly SessionSummary[];
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onPin: () => void;
  readonly onRename: () => void;
  readonly onRenamed: (name: string | null | undefined) => void;
  readonly onArchive: () => void;
}) {
  const name = directionName(direction);
  const card = directionCard(direction, sessions);
  return (
    <div
      role="group"
      aria-label={name}
      className="relative min-h-[86px] rounded-[14px] bg-[var(--surface-1)] px-3.5 py-3 text-[length:var(--fs-meta)] shadow-[var(--card-shadow)] hover:bg-[var(--hover)]"
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
        {card.mark === "asking" ? (
          <span className="shrink-0 rounded-[5px] bg-[var(--attn-soft)] px-[5px] text-[length:var(--fs-xs)] leading-[17px] font-medium text-[var(--attn-text)]">
            待回答
          </span>
        ) : card.mark === "running" ? (
          <span role="img" aria-label="在跑" className="size-[7px] shrink-0 rounded-full bg-[var(--ok)]" />
        ) : null}
        {card.tag === null ? null : (
          <span className="shrink-0 rounded-[5px] bg-[var(--surface-2)] px-[5px] text-[length:var(--fs-xs)] leading-[17px] font-medium text-[var(--text-muted)]">
            {card.tag}
          </span>
        )}
      </div>
      <p
        className={`mt-[3px] flex items-center gap-1 text-[length:var(--fs-sm)] ${card.warn ? "text-[var(--attn-text)]" : "text-[var(--text-muted)]"}`}
      >
        {card.warn ? <Warning size={12} aria-hidden /> : null}
        {card.line}
      </p>
      {card.dots === null ? null : (
        <div className="mt-2.5 flex">
          <StepDots dots={card.dots} small />
        </div>
      )}
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

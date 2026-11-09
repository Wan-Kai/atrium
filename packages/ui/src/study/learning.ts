import { type AtriumClient, CommandError, type IndexView, isDirectionId } from "@atrium/client";
import type { Direction, ModelRef, SessionSummary, ThinkingLevel } from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";
import { type FirstMessages, firstMessages } from "../chat/first-message";
import type { CompressedImage } from "../chat/images";
import type { Drafts } from "../state/drafts";
import { progressLine } from "./progress";

// Study mode in this window (SPEC-0008, ML1): the learning home and the new-direction page, which
// show in place of the tab bar and the conversation area, and whether each direction shows its
// home tab. None of it goes to the host (domain-model, "已决定 20").

/** The learning pages a window shows over the main area. */
export type LearningPage = "home" | "new";

/** The model and thinking level chosen on the new-direction page; `null` for the usual. */
interface DirectionModel {
  readonly ref: ModelRef | null;
  readonly level: ThinkingLevel | null;
}

/** The window's study state. */
export interface LearningState {
  /** The learning page shown, or `null` for none. */
  readonly page: LearningPage | null;
  /** The directions whose home tab shows over their session tabs, by id. */
  readonly homes: Readonly<Record<string, boolean>>;
  /** The model chosen on the new-direction page. */
  readonly model: DirectionModel;
  /** A first message on its way: its direction is being named and made. */
  readonly sending: boolean;
  /** Why the last send from the new-direction page failed; `undefined` while none did. */
  readonly failure: unknown;
  /**
   * A direction made by the last send whose session could not be created, and why; its home says
   * so. `null` for none.
   */
  readonly stranded: { readonly directionId: string; readonly failure: unknown } | null;
}

/** Where the new-direction page keeps what is typed in its box. */
export const NEW_DIRECTION_DRAFT = "new-direction";

/**
 * Creates the window's study store: no page, no home shown.
 *
 * @remarks
 * One for the window, like the new-workspace page's: what is being sent outlives the page.
 *
 * @sideEffects none
 * @returns The store.
 */
export function createLearningStore(): StoreApi<LearningState> {
  return createStore<LearningState>(() => ({
    page: null,
    homes: {},
    model: { ref: null, level: null },
    sending: false,
    failure: undefined,
    stranded: null,
  }));
}

/**
 * Opens a learning page.
 *
 * @remarks
 * Opening the new-direction page again starts afresh, as it is only a way in (SPEC-0008, "新建方向").
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 * @param page - The page.
 */
export function openLearning(store: StoreApi<LearningState>, page: LearningPage): void {
  store.setState(page === "new" ? { page, failure: undefined, model: { ref: null, level: null } } : { page });
}

/**
 * Leaves the learning page, if one shows.
 *
 * @remarks
 * A send under way goes on.
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 */
export function closeLearning(store: StoreApi<LearningState>): void {
  if (store.getState().page !== null) store.setState({ page: null });
}

/**
 * Shows or hides a direction's home tab over its sessions.
 *
 * @remarks
 * design-language ("学习模式"): the home tab is the leftmost, fixed; a session tab chosen hides it.
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 * @param directionId - The direction.
 * @param shown - Whether it shows.
 */
export function showHome(store: StoreApi<LearningState>, directionId: string, shown: boolean): void {
  if ((store.getState().homes[directionId] ?? false) === shown) return;
  store.setState(({ homes }) => ({ homes: { ...homes, [directionId]: shown } }));
}

/**
 * A direction's name: the user's, else its own display name.
 *
 * @remarks
 * domain-model §1, Direction: `alias` or `name`.
 *
 * @sideEffects none
 * @param direction - The direction.
 * @returns The name.
 */
export function directionName(direction: Pick<Direction, "alias" | "name">): string {
  return direction.alias ?? direction.name;
}

/**
 * Where a direction stands, in a few words: under discussion until it has a ladder.
 *
 * @remarks
 * SPEC-0008 ("讨论"): `discussing` says whether the ladder is written; a broken marker shows as
 * under discussion. With a ladder, the line is where the learner is (`progressLine`, ML2).
 *
 * @sideEffects none
 * @param direction - The direction.
 * @returns Its stage and a line about it.
 */
export function directionStage(direction: Pick<Direction, "discussing" | "broken" | "progress">): {
  readonly stage: string;
  readonly line: string;
} {
  if (direction.broken) return { stage: "讨论中", line: "档案读不出来，先按讨论中显示" };
  if (direction.discussing || direction.progress === null) return { stage: "讨论中", line: "还没排出阶梯" };
  return { stage: "已排好阶梯", line: progressLine(direction.progress) };
}

/**
 * The directions not archived, in the order the learning home shows them.
 *
 * @remarks
 * Pinned first, the one pinned first leading; then the one opened last, then the newest made
 * (SPEC-0008, "ML1 定的细节", confirmed 2026-11-06).
 *
 * @sideEffects none
 * @param directions - The directions.
 * @returns The directions.
 */
export function listedDirections(directions: readonly Direction[]): Direction[] {
  return directions
    .filter((direction) => !direction.archived)
    .toSorted(
      (a, b) =>
        Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) ||
        (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) ||
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The direction the learning home's "继续" offers: the one opened last.
 *
 * @remarks
 * SPEC-0008 ("入口"): the last opened, not archived; none before any was opened.
 *
 * @sideEffects none
 * @param directions - The directions.
 * @returns The direction, or `undefined`.
 */
export function continueDirection(directions: readonly Direction[]): Direction | undefined {
  return directions
    .filter((direction) => !direction.archived && direction.lastOpenedAt !== null)
    .toSorted((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
}

/**
 * The sessions that count for the sidebar's "学习" row and the inbox.
 *
 * @remarks
 * SPEC-0008 ("ML1 定的细节"): only those of directions not archived; an archived direction's
 * sessions cannot run, as their directory moved.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The sessions of every container but archived directions.
 */
export function liveSessions(index: Pick<IndexView, "sessions" | "directions">): SessionSummary[] {
  const archived = new Set(index.directions.filter((direction) => direction.archived).map(({ id }) => id));
  return index.sessions.filter((session) => !archived.has(session.containerId));
}

/**
 * The sessions of directions not archived, for the "学习" row's status.
 *
 * @remarks
 * See `liveSessions`; archived sessions are left out, as everywhere.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The sessions.
 */
export function studySessions(index: Pick<IndexView, "sessions" | "directions">): SessionSummary[] {
  return liveSessions(index).filter((session) => isDirectionId(session.containerId) && !session.archived);
}

/**
 * A direction's sessions its home lists, last active first.
 *
 * @remarks
 * SPEC-0008 ("ML1 定的细节"): its sessions not archived, each opened from its row; there is no
 * "继续讨论". An archived direction lists them too, to be read.
 *
 * @sideEffects none
 * @param sessions - The list's sessions.
 * @param directionId - The direction.
 * @returns The sessions.
 */
export function directionSessions(sessions: readonly SessionSummary[], directionId: string): SessionSummary[] {
  return sessions
    .filter((session) => session.containerId === directionId && !session.archived)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Opens one of a direction's sessions from its home.
 *
 * @remarks
 * The session shows over the home tab; the direction becomes where the client is, as its home
 * already made it, and an archived direction's session opens to be read (SPEC-0008, "ML1 定的细节").
 *
 * @sideEffects Sends `open_session`; updates the store.
 * @param client - The client.
 * @param store - The study store.
 * @param directionId - The direction.
 * @param sessionId - The session.
 * @returns When the host answered.
 */
export async function openDirectionSession(
  client: Pick<AtriumClient, "openSession">,
  store: StoreApi<LearningState>,
  directionId: string,
  sessionId: string,
): Promise<void> {
  closeLearning(store);
  showHome(store, directionId, false);
  await client.openSession(sessionId);
}

/** What sending from the new-direction page asks of the client. */
export type DirectionLaunchClient = Pick<
  AtriumClient,
  "createDirection" | "createSession" | "selectContainer" | "setModel" | "setThinkingLevel" | "listCommands" | "prompt"
>;

/** An image of the first message, uploaded. */
export interface DirectionImage {
  readonly attachmentId: string;
  readonly image: CompressedImage;
}

/**
 * Sends the new-direction page's first message: the host names and makes the direction with its
 * discussion session, then the message goes to that session.
 *
 * @remarks
 * SPEC-0008 ("新建方向", "ML1 定的细节"), as the new-workspace page sends: the page closes once
 * the session is there, as the host takes the client to it; the model and level chosen are set
 * first, else pi's start is waited for by listing its commands. A message opening with
 * `/atrium-` fails before anything is made, as the host would refuse it only once the direction
 * was made. A failure before the session puts the message back into the page's box; after, into
 * the session's. A direction made whose discussion the host could not create (`sessionId` `null`)
 * is not made again: the message goes to a new session in it, and when that fails too the client
 * goes to the direction's home with the message back in the page's box (SPEC-0008, "ML1 定的细节").
 * Once the session is there and until the message went (or failed), what is sent from the
 * session's box waits behind it (`first`), so it cannot reach pi first while the model is set and
 * pi starts (SPEC-0008, "真实模型检查后改").
 *
 * @sideEffects Sends commands; updates the store and the drafts; holds the session's later messages.
 * @param store - The study store.
 * @param client - The client.
 * @param drafts - The page's drafts.
 * @param message - The message and its uploaded images.
 * @param first - The holds the session's box waits on; the page's when left out.
 */
export async function launchDirection(
  store: StoreApi<LearningState>,
  client: DirectionLaunchClient,
  drafts: Pick<Drafts, "restore" | "handOver">,
  message: { readonly text: string; readonly images: readonly DirectionImage[] },
  first: Pick<FirstMessages, "hold"> = firstMessages(),
): Promise<void> {
  const { model } = store.getState();
  let release: (() => void) | undefined;
  store.setState({ sending: true, failure: undefined, stranded: null });
  let sessionId: string | null = null;
  try {
    // The box empties once its send handler returns; a message put back before then would go too.
    await Promise.resolve();
    if (message.text.trimStart().startsWith("/atrium-")) throw new CommandError("command_reserved");
    const created = await client.createDirection(message.text, model.ref);
    try {
      sessionId = created.sessionId ?? (await client.createSession(created.directionId)).sessionId;
    } catch (failure) {
      store.setState(({ homes }) => ({
        page: null,
        homes: { ...homes, [created.directionId]: true },
        stranded: { directionId: created.directionId, failure },
      }));
      // Fire and forget: the home shows the direction; a failed move leaves the client where it was.
      void client.selectContainer(created.directionId).catch(() => undefined);
      throw failure;
    }
    // Before the session's box can be used: what is sent there waits for this message.
    release = first.hold(sessionId);
    // What was typed meanwhile goes with the session.
    drafts.handOver(NEW_DIRECTION_DRAFT, sessionId);
    store.setState(({ homes }) => ({ page: null, homes: { ...homes, [created.directionId]: false } }));
    if (model.ref !== null) await client.setModel(sessionId, model.ref);
    if (model.level !== null) await client.setThinkingLevel(sessionId, model.level);
    if (model.ref === null && model.level === null) await client.listCommands(sessionId);
    await client.prompt(
      sessionId,
      message.text,
      message.images.map((image) => image.attachmentId),
      message.images.map((image) => image.image.preview),
    );
    store.setState({ sending: false });
  } catch (failure) {
    store.setState({ sending: false, failure: sessionId === null ? failure : undefined });
    const kept = message.images.map((image) => ({ ...image, id: crypto.randomUUID() }));
    drafts.restore(sessionId ?? NEW_DIRECTION_DRAFT, message.text, kept);
  } finally {
    release?.();
  }
}

/** What the study commands' failures say, by code; any other is "出错了，再试一次". */
const STUDY_ERRORS: Partial<Readonly<Record<CommandError["code"], string>>> = {
  study_restore_conflict: "原来的位置已经有同名的目录了，先把它挪走再恢复",
  study_archive_conflict: "Archive 里已经有同名的目录了，先把它挪走再归档",
  study_move_failed: "没能移动方向的目录",
  learning_dir_unsafe: "学习目录或它的 Archive 是链接或者不是目录，先改回普通目录",
  direction_archived: "这个方向已归档，恢复以后才能接着学",
  direction_not_found: "这个方向已经不在了",
  direction_create_failed: "没能建好方向的目录",
  command_reserved: "以 /atrium- 开头的消息留给 Atrium 自己用",
  pi_unavailable: "pi 现在用不了",
  study_not_available: "这一步现在开不了",
  study_mark_refused: "这一项现在不能这样标",
  study_not_found: "这一步已经不在进度里了",
  study_file_broken: "档案读不出来，没有改动它",
  study_file_version: "档案是更新版本的 Atrium 写的，这里不改它",
  study_write_failed: "没能写进档案",
  study_file_too_large: "档案会超过 1 MiB，没有写进去",
  study_kickoff_failed: "pi 没有加载 Atrium 的学习扩展",
};

/**
 * Why a session the host opened for a use did not start, in Chinese.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": the host gives only the code (`kickoff`).
 *
 * @sideEffects none
 * @param code - The code.
 * @returns The words.
 */
export function describeKickoff(code: CommandError["code"]): string {
  return `这一步的会话没能开始：${STUDY_ERRORS[code] ?? "出错了"}`;
}

/**
 * Explains a failed direction command, in Chinese.
 *
 * @remarks
 * The host sends codes only (AGENTS.md); these words are provisional (ML1).
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @returns The sentence.
 */
export function describeStudyError(error: unknown): string {
  const code = error instanceof CommandError ? error.code : null;
  return (code === null ? undefined : STUDY_ERRORS[code]) ?? "出错了，再试一次";
}

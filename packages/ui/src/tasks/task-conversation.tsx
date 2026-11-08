import type { AtriumClient, SessionView } from "@atrium/client";
import { loadingView } from "@atrium/client";
import type { TaskRequirements, TranscriptItem, Verdict } from "@atrium/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { Composer, type ComposerProps, type SentImage } from "../chat/composer";
import { ControlCards, type RunActions } from "../chat/run-control";
import { Transcript } from "../chat/transcript";
import { pageDrafts } from "../state/use-draft";
import { claimWatch } from "../state/watch-owner";
import { RequirementsCard } from "./requirements-card";
import { describeTaskCommandError } from "./review-words";

/** The marker the host's first message to a task conversation starts with (SPEC-0006, "任务对话"). */
const DESIGN_MARK = "<atrium-task-design>";

/** What the host's long instruction for designing the task is shown as: it is the host's, not the user's words. */
const DESIGN_STAND_IN = "（设计任务的指示：整理需求摘要，选引导词，画初始图）";

/** The view of a conversation not watched yet. */
const NOT_WATCHED = createStore<SessionView>(() => loadingView(""));

/**
 * The items with the host's instruction for designing the task shortened to one line.
 *
 * @remarks
 * The first turn of a task conversation opens with the host's whole instruction, the four guides in full
 * (SPEC-0006, "附录：引导词"); shown as the user's message it would fill the first screen. The turn and what the agent
 * did in it stay.
 *
 * @sideEffects none
 * @param items - The conversation's items.
 * @returns The items.
 */
function withoutDesignPrompt(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  if (!items.some((item) => item.kind === "turn" && item.user.text.startsWith(DESIGN_MARK))) return items;
  return items.map((item) =>
    item.kind === "turn" && item.user.text.startsWith(DESIGN_MARK)
      ? { ...item, user: { ...item.user, text: DESIGN_STAND_IN } }
      : item,
  );
}

/**
 * Gets a session of a task running in the host if it is not, so it can be watched and written to.
 *
 * @remarks
 * A task or node conversation whose pi is not running (a node that passed, a task that ended, a host that
 * restarted) gives no snapshot to a watcher; `open_task_session` starts only its pi, without opening a tab
 * (SPEC-0006, "T8a 定下的细节"). Never `open_session`, which would put the conversation among the project's tabs.
 * A view that is `lost` (the host was replaced) is as much without a pi as one still `loading`.
 *
 * @sideEffects Sends `open_task_session` when the view is still loading or lost.
 * @param client - The client.
 * @param taskId - The task the session belongs to.
 * @param sessionId - The session.
 * @returns Resolves once the host has started it, or at once when it is already there.
 */
async function ensureTaskSession(client: AtriumClient, taskId: string, sessionId: string): Promise<void> {
  const status = client.session(sessionId)?.getState().status;
  if (status !== "loading" && status !== "lost") return;
  await client.openTaskSession(taskId, sessionId);
}

/**
 * A conversation of a task, with its input box: the task conversation, or a node's (SPEC-0006, "界面"; T8).
 *
 * @remarks
 * Task conversations are left out of the list and the sidebar, so one is watched by its id through the same session
 * subscription any conversation uses, and never opened as a tab. If its pi is not running it is started with
 * `open_task_session` after the watch. The input box sends with `prompt` (queued while a run goes on) and `steer`
 * (⌘+Enter) on this session's id. While a review is open a message goes to the conversation and the review stays
 * (ADR-0017); the cards (a question and the reviews) wait above the box. `extra` is the part above the transcript
 * (the requirements summary). A task that is only followed (T7.1) has its conversation in another process: the
 * pane says so, watches nothing and has no box.
 *
 * @sideEffects Watches the session while mounted (this replaces the sessions watched before, which is why the task
 * area and the conversations are never mounted together); starts its pi if needed; sends messages, stops and
 * verdicts; loads older items and whole steps on request.
 * @param props - The client, the task and session ids, the pane's title, whether the task is only followed, the
 * requirements to show, and whether the pane is a node's.
 * @returns The conversation.
 */
export function TaskConversation({
  client,
  taskId,
  sessionId,
  followed,
  title = "任务对话",
  requirements,
  above,
  idlePlaceholder = "问进度、要改图、给节点带话",
  heading = true,
}: {
  readonly client: AtriumClient;
  readonly taskId: string;
  readonly sessionId: string;
  readonly followed: boolean;
  readonly title?: string;
  readonly requirements?: TaskRequirements;
  readonly above?: ReactNode;
  /** What the empty box says while no review waits, in place of the task conversation's own line. */
  readonly idlePlaceholder?: string;
  /** Whether the pane has its own title row; a node's tab has the header above it instead. */
  readonly heading?: boolean;
}) {
  const [store, setStore] = useState(() => client.session(sessionId));
  const [failure, setFailure] = useState<string | null>(null);
  // Lets go of the claim in force on this pane's watch (the latest: a host restart claims it again).
  const release = useRef<() => void>(() => undefined);
  useEffect(() => {
    // A followed task's conversation is not in this host; watching it would wait for ever.
    if (followed) return undefined;
    let current = true;
    // Fire and forget: a lost connection subscribes again when it is back; starting the pi can fail and then the
    // pane keeps saying it is reading.
    const claim = claimWatch(client, [sessionId]);
    release.current = claim.release;
    claim.watched
      .then(() => (current ? ensureTaskSession(client, taskId, sessionId) : undefined))
      .catch(() => undefined);
    // `watch` makes the view at once, and this has to render again to subscribe to it.
    // oxlint-disable-next-line react/set-state-in-effect -- the client is the external system here.
    setStore(client.session(sessionId));
    return () => {
      current = false;
      // Not watched once the pane is gone, unless something else has taken the watch since.
      release.current();
    };
  }, [client, taskId, sessionId, followed]);
  // The host instance last connected to; a new one has lost every session's view, and so this one's.
  const hostInstance = useStore(client.connection, (state) =>
    state.status === "connected" ? state.hostInstanceId : null,
  );
  const lastHost = useRef<string | null>(null);
  useEffect(() => {
    if (hostInstance === null) return;
    const before = lastHost.current;
    lastHost.current = hostInstance;
    if (before === null || before === hostInstance || followed) return;
    // The host restarted: the session shown is watched and started again at once, as a session tab is, rather than
    // on the next message. Fire and forget: a lost connection subscribes again when it is back.
    const claim = claimWatch(client, [sessionId]);
    release.current = claim.release;
    claim.watched.then(() => ensureTaskSession(client, taskId, sessionId)).catch(() => undefined);
    // Only when the host changes; the effect above watches a session shown later.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [client, hostInstance]);
  const view = useStore(store ?? NOT_WATCHED);
  const shown = useMemo(() => ({ ...view, items: withoutDesignPrompt(view.items) }), [view]);
  const running = view.run !== null;

  /**
   * Runs a command on the conversation, saying why it failed if it does.
   *
   * @remarks
   * The pi is started first if it is not running (a message to a conversation with no pi would be lost).
   *
   * @sideEffects Sends the command; updates the failure shown above the box.
   * @param command - The command.
   * @returns Whether it went.
   */
  const attempt = useCallback(
    async (command: () => Promise<unknown>): Promise<boolean> => {
      setFailure(null);
      try {
        await ensureTaskSession(client, taskId, sessionId);
        await command();
        return true;
      } catch (error) {
        setFailure(describeTaskCommandError(error));
        return false;
      }
    },
    [client, taskId, sessionId],
  );
  /**
   * Sends a message through `attempt`, and puts it back in the box if it did not go.
   *
   * @remarks
   * As the chat's box does with a message the host refused or that could not be sent (T8 review fix 6); the box was
   * cleared when the message was sent, so the text goes back only if nothing new was typed meanwhile.
   *
   * @sideEffects As `attempt`; may put the text back into the draft.
   * @param text - The message.
   * @param command - What sends it.
   */
  const attemptOrRestore = async (text: string, command: () => Promise<unknown>): Promise<void> => {
    if (!(await attempt(command))) pageDrafts().restore(sessionId, text, []);
  };
  const actions: RunActions = {
    resume: () => void attempt(() => client.resumeQueue(sessionId)),
    clear: () => void attempt(() => client.clearQueue(sessionId)),
    update: (itemId, text) => void attempt(() => client.updateQueued(sessionId, itemId, text)),
    remove: (itemId) => void attempt(() => client.removeQueued(sessionId, itemId)),
    steerQueued: (itemId) => void attempt(() => client.steerQueued(sessionId, itemId)),
    removeDelivery: (deliveryId) => void attempt(() => client.removeDelivery(sessionId, deliveryId)),
    resumeDeliveries: () => void attempt(() => client.resumeDeliveries(sessionId, false)),
    answer: (interactionId, answer) => void attempt(() => client.answerInteraction(sessionId, interactionId, answer)),
    answerQuestion: (questionId, reply) => attempt(() => client.answerQuestion(sessionId, questionId, reply)),
    answerReview: async (reviewId: string, verdict: Verdict) => {
      try {
        await client.answerReview(sessionId, reviewId, verdict);
        return null;
      } catch (error) {
        return describeTaskCommandError(error);
      }
    },
    retry: () => void attempt(() => client.retryRun(sessionId)),
  };
  /**
   * Sends the box's message to this conversation.
   *
   * @remarks
   * `prompt` on the session's id (queued while a round goes on). It never opens the conversation as a session. A
   * review that is open stays: for the host's gates a message is only a message (ADR-0017). A message that did not
   * go (the session could not be started, the host refused it) is put back in the box, as the chat's box does.
   *
   * @sideEffects Sends `prompt`; may put the text back into the draft.
   * @param text - The message.
   * @param _images - The images; the box offers none here.
   */
  const send: ComposerProps["onSend"] = (text: string, _images: readonly SentImage[]) => {
    // Fire and forget: a failure is shown above the box and the message goes back into it.
    void attemptOrRestore(text, () => client.prompt(sessionId, text));
  };
  /**
   * Steers the round that goes on with the box's message (⌘+Enter).
   *
   * @remarks
   * Delivered before the agent's next step, as in any conversation. A steer that did not go is put back in the box.
   *
   * @sideEffects Sends `steer`; may put the text back into the draft.
   * @param text - The message.
   */
  const steer: NonNullable<ComposerProps["onSteer"]> = (text: string) => {
    void attemptOrRestore(text, () => client.steer(sessionId, text));
  };
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {heading ? (
        <h2 className="flex h-9 shrink-0 items-center px-4 text-[length:var(--fs-meta)] font-medium text-[var(--text-2)]">
          {title}
        </h2>
      ) : null}
      {above}
      {requirements === undefined ? null : <RequirementsCard requirements={requirements} />}
      {followed ? (
        <div role="status" className="px-6 py-6 text-[length:var(--fs-meta)]">
          <p className="text-[var(--text-2)]">这个任务是别的进程在跑的，Atrium 只读它的图和节点状态。</p>
          <p className="mt-1 text-[var(--text-dim)]">任务对话和各节点的对话不在 Atrium 里，这里看不到。</p>
        </div>
      ) : (
        <>
          {view.status === "loading" ? (
            <p role="status" className="px-6 py-6 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
              正在读取{title}…
            </p>
          ) : (
            <Transcript
              view={shown}
              onLoadOlder={() => void client.loadOlder(sessionId).catch(() => undefined)}
              onLoadStep={(turnId, stepId) => void client.loadStep(sessionId, turnId, stepId).catch(() => undefined)}
            />
          )}
          {failure === null ? null : (
            <p
              role="alert"
              data-testid="conversation-failure"
              className="mx-auto w-full max-w-[var(--column)] px-6 pb-2 text-[length:var(--fs-meta)] text-[var(--danger)]"
            >
              {failure}
            </p>
          )}
          <Composer
            key={sessionId}
            draftKey={sessionId}
            onSend={send}
            onSteer={steer}
            onStop={() => void attempt(() => client.stop(sessionId))}
            running={running}
            asked={view.control.question !== null}
            stopping={view.control.stopping}
            compacting={view.control.compacting}
            idlePlaceholder={view.control.reviews.length > 0 ? "直接回复也行：发给任务对话，卡片不动" : idlePlaceholder}
            pinned={
              <ControlCards
                sessionId={sessionId}
                control={view.control}
                actions={actions}
                settled={view.status === "ready"}
              />
            }
          />
        </>
      )}
    </section>
  );
}

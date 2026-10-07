import type { SessionView } from "@atrium/client";
import { ArrowDown } from "@phosphor-icons/react";
import { useRef } from "react";
import { useFollowBottom } from "./follow-bottom";
import { AssistantReply, UserBubble } from "./messages";
import { RunStatus } from "./run-status";

/**
 * A session's conversation: messages, pending sends, the run in progress and the reply streaming.
 *
 * @remarks
 * Content is at most 720 px wide (design-language, "圆角、尺寸与间距"). The view follows new
 * content while scrolled to the bottom; scrolling up stops that and shows "↓ 回到底部", with a dot
 * once something new arrived (SPEC-0001, "滚动与长会话"). Pending messages are the ones sent but
 * not yet confirmed by the host (domain-model §7).
 *
 * @sideEffects Observes the content's size and scrolling while mounted.
 * @param props - The session's view.
 * @returns The scrollable conversation.
 */
export function Transcript({ view }: { readonly view: SessionView }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useFollowBottom(scroller, content);
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-y-auto" data-testid="transcript">
        <div ref={content} className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8">
          {view.messages.map((message) =>
            message.role === "user" ? (
              <UserBubble key={message.id} text={message.text} timestamp={message.timestamp} />
            ) : (
              <AssistantReply key={message.id} content={message.content} streaming={false} finished={message} />
            ),
          )}
          {view.pending.map((message) => (
            <UserBubble key={message.clientMessageId} text={message.text} />
          ))}
          {view.run === null ? null : <RunStatus startedAt={view.run.startedAt} />}
          {view.streaming === null ? null : (
            <AssistantReply key={view.streaming.messageId} content={view.streaming.content} streaming />
          )}
        </div>
      </div>
      {follow.following ? null : (
        <button
          type="button"
          onClick={follow.jumpToBottom}
          className="absolute right-6 bottom-4 flex items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--surface-1)] px-3 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line),0_9px_27px_rgba(41,70,122,0.08)]"
        >
          <ArrowDown size={13} weight="bold" />
          回到底部
          {follow.unseen ? <span className="size-1.5 rounded-full bg-[var(--tint)]" data-testid="unseen-dot" /> : null}
        </button>
      )}
    </div>
  );
}

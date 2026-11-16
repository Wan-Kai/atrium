import type { AtriumClient } from "@atrium/client";
import { useState } from "react";
import { useStore } from "zustand";
import { describeKickoff } from "./learning";

/**
 * The line a session the host opened for a use shows when it did not start, with "重试".
 *
 * @remarks
 * SPEC-0008 ("ML2 定的细节"), design-language ("学习模式"): the host gives the session's
 * `kickoff` as a code; the words are the UI's. "重试" asks the host to send the start again,
 * and waits while it does; the line goes once the session's `kickoff` is `null`.
 *
 * @sideEffects Subscribes to the list; sends `retry_study_kickoff` when "重试" is pressed.
 * @param props - The client and the session.
 * @returns The line, or nothing for a session that started.
 */
export function StudyKickoffLine({ client, sessionId }: { readonly client: AtriumClient; readonly sessionId: string }) {
  const code = useStore(
    client.index,
    (index) => index.sessions.find((one) => one.sessionId === sessionId)?.kickoff?.code ?? null,
  );
  const [busy, setBusy] = useState(false);
  if (code === null) return null;
  return (
    <p
      role="alert"
      className="mx-auto flex w-full max-w-[var(--column)] items-center gap-2 px-6 pb-2 text-[length:var(--fs-meta)] text-[var(--danger)]"
    >
      <span className="min-w-0">{describeKickoff(code)}</span>
      <button
        type="button"
        disabled={busy}
        className="shrink-0 text-[var(--tint)] hover:underline disabled:opacity-[0.42]"
        onClick={() => {
          setBusy(true);
          // Fire and forget: a failure stays shown through the session's `kickoff`.
          void client
            .retryStudyKickoff(sessionId)
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}
      >
        重试
      </button>
    </p>
  );
}

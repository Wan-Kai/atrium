import type { AtriumClient } from "@atrium/client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type StoreApi, useStore } from "zustand";
import { Check } from "../design/icons";
import { PRIMARY_BUTTON } from "../settings/parts";
import { type LearningState, confirmUpgrade, describeStudyError, directionSessions } from "./learning";
import { upgradeView } from "./loop";

/**
 * The upgrade confirmation: what upgrading does, archiving the level's sessions (on by default),
 * the gaps carried, the sessions it would stop, then "先不升" or the upgrade.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 升级确认框" and prototype 4A, laid out as the archive confirmation
 * is: on the page's body over a blurred scrim, the focus on "先不升", Escape and the scrim cancel.
 * The last level's says "学完最后一级" and opens no plan. While the host answers both buttons wait;
 * a failure shows in the dialog, which stays. The host opens the plan session's tab itself.
 *
 * @sideEffects Focuses "先不升"; listens for Escape; sends `upgrade_study` when confirmed; updates
 * the study store.
 * @param props - The client, the study store, the direction and the level upgraded from.
 * @returns The dialog, or nothing once the direction or the level is gone.
 */
export function UpgradeDialog({
  client,
  store,
  directionId,
  level,
}: {
  readonly client: Pick<AtriumClient, "index" | "upgradeStudy">;
  readonly store: StoreApi<LearningState>;
  readonly directionId: string;
  readonly level: string;
}) {
  const direction = useStore(client.index, (index) => index.directions.find((one) => one.id === directionId));
  const all = useStore(client.index, (index) => index.sessions);
  const [archive, setArchive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    /**
     * Cancels on Escape.
     *
     * @remarks
     * Like the scrim and "先不升"; not while the host answers.
     *
     * @sideEffects Updates the study store.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) confirmUpgrade(store, null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [store, busy]);
  const view =
    direction?.progress === null || direction?.progress === undefined
      ? null
      : upgradeView(direction.progress, level, directionSessions(all, directionId));
  if (view === null) return null;
  /**
   * Closes the dialog, unless the host is answering.
   *
   * @remarks
   * "先不升", the scrim.
   *
   * @sideEffects Updates the study store.
   */
  const close = (): void => {
    if (!busy) confirmUpgrade(store, null);
  };
  /**
   * Upgrades, closing the dialog once the host has.
   *
   * @remarks
   * Sends whether to archive as the box says; with nothing to archive, `false`.
   *
   * @sideEffects Sends `upgrade_study`; updates the study store.
   */
  const upgrade = (): void => {
    setBusy(true);
    setProblem(null);
    // Fire and forget: a failure shows in the dialog.
    void client
      .upgradeStudy(directionId, level, archive && view.archive !== null)
      .then(() => confirmUpgrade(store, null))
      .catch((error: unknown) => setProblem(describeStudyError(error)))
      .finally(() => setBusy(false));
  };
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div
        data-testid="upgrade-scrim"
        className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px] backdrop-saturate-[1.1]"
        onClick={close}
      />
      <div
        role="alertdialog"
        aria-modal
        aria-labelledby="upgrade-title"
        aria-describedby="upgrade-body"
        className="relative max-h-[calc(100dvh-24px)] w-[min(400px,calc(100vw-24px))] overflow-y-auto rounded-[var(--r-card)] bg-[var(--main)] p-5 shadow-[var(--float-shadow)] [overflow-wrap:anywhere]"
      >
        <h2 id="upgrade-title" className="mb-1 text-[15px] font-semibold text-[var(--text)]">
          {view.title}
        </h2>
        <div id="upgrade-body" className="text-[length:var(--fs-meta)] leading-[1.55]">
          <p className="mb-3 text-[var(--text-muted)]">{view.body}</p>
          {view.archive === null ? null : (
            <>
              <label className="flex cursor-pointer items-center gap-2 py-1 text-[var(--text-2)]">
                <input
                  type="checkbox"
                  checked={archive}
                  onChange={(event) => setArchive(event.target.checked)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={`grid size-4 shrink-0 place-items-center rounded-[5px] peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--tint)] ${
                    archive ? "bg-[var(--tint)] text-[var(--on-tint)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)]"
                  }`}
                >
                  {archive ? <Check size={12} /> : null}
                </span>
                {view.archive}
              </label>
              <p className="pl-6 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                档案和笔记都留着，会话能在“已归档”里恢复。
              </p>
            </>
          )}
          {view.carried === null ? null : (
            <p className="mt-2.5 flex items-center gap-2 text-[var(--text-2)]">
              <i aria-hidden className="block size-2 shrink-0 rounded-[2px] bg-[var(--attn)]" />
              {view.carried}
            </p>
          )}
          {archive && view.archive !== null && view.running > 0 ? (
            <p className="mt-2 text-[var(--danger)]">会停掉 {view.running} 个在跑的会话。</p>
          ) : null}
          {problem === null ? null : (
            <p role="alert" className="mt-2 text-[var(--danger)]">
              {problem}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            disabled={busy}
            onClick={close}
            className="h-[30px] rounded-[var(--r-btn)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)] disabled:opacity-[0.42]"
          >
            先不升
          </button>
          <button type="button" disabled={busy} onClick={upgrade} className={PRIMARY_BUTTON}>
            {view.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

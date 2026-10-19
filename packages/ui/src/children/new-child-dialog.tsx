import { type AtriumClient, isChatId } from "@atrium/client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { sessionTitle } from "../sidebar/names";
import { suggestBranch } from "../state/new-workspace";
import { showNotice } from "../state/session-notices";
import { childrenOf } from "./children";
import { type ChildRequest, describeChildError, keptChild, pageNewChild } from "./new-child";

/** A field's look in the dialog. */
const FIELD =
  "h-[30px] w-full rounded-[var(--r)] bg-[var(--surface-2)] px-2.5 text-[length:var(--fs-meta)] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--tint)] dark:bg-[var(--main)]";

/**
 * A choice's look in the place switch.
 *
 * @remarks
 * The chosen one is raised, as a segmented control's.
 *
 * @sideEffects none
 * @param chosen - Whether it is chosen.
 * @returns The classes.
 */
const CHOICE = (chosen: boolean) =>
  `rounded-[var(--r-sm)] px-3 py-[3px] text-[length:var(--fs-sm)] ${
    chosen
      ? "bg-[var(--surface-1)] text-[var(--text)] shadow-[0_0_0_0.5px_var(--line),0_1px_2px_rgba(0,0,0,0.08)] dark:bg-[var(--surface-2)]"
      : "text-[var(--text-muted)]"
  }`;

/**
 * The dialog that opens a child conversation, shown while the page asks for one.
 *
 * @remarks
 * SPEC-0002 ("第一步 · 入口"; prototype A): it names the child ("子对话 N" to start), and places
 * it in the parent's container or, for a workspace's session, in a new worktree on a branch it
 * suggests. From a reply it carries the conversation up to that turn (`fork_session`), from the
 * tab bar's menu it is empty (`create_session`); the host opens it as the active tab. A failure
 * stays in the dialog, in words, and the dialog stays open.
 *
 * @sideEffects Sends `fork_session` or `create_session`; closes the page's request.
 * @param props - The client.
 * @returns The dialog, or nothing.
 */
export function NewChildDialog({ client }: { readonly client: AtriumClient }) {
  const request = useStore(pageNewChild());
  if (request === null) return null;
  return <ChildForm key={`${request.parentSessionId}:${request.turnId ?? ""}`} client={client} request={request} />;
}

/**
 * The dialog's form for one request.
 *
 * @remarks
 * See `NewChildDialog`. Focus starts in the name; Escape and the scrim cancel, except while it
 * waits for the host.
 *
 * @sideEffects Focuses the name; listens for Escape while not busy; sends the command.
 * @param props - The client and the request.
 * @returns The dialog.
 */
function ChildForm({ client, request }: { readonly client: AtriumClient; readonly request: ChildRequest }) {
  const index = useStore(client.index);
  const parent = index.sessions.find((session) => session.sessionId === request.parentSessionId);
  const [name, setName] = useState(
    () => `子对话 ${String(childrenOf(index.sessions, request.parentSessionId).length + 1)}`,
  );
  const [place, setPlace] = useState<"same" | "worktree">("same");
  const [branch, setBranch] = useState(() => suggestBranch(Math.random));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.select();
  }, []);
  useEffect(() => {
    if (busy) return undefined;
    /**
     * Cancels on Escape.
     *
     * @remarks
     * Not while the host is answering, as the answer would come with no dialog to say it.
     *
     * @sideEffects Closes the request.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") pageNewChild().setState(null, true);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy]);
  if (parent === undefined) return null;
  const inChat = isChatId(parent.containerId);
  // Neither a branch nor a detached commit: the project is no git repository (SPEC-0002, "概念 · 位置").
  const workspace = index.workspaces.find((one) => one.id === parent.containerId);
  const onlyHere = inChat || (workspace?.branch === null && workspace.head === null);
  const title = sessionTitle(parent);

  /**
   * Opens the child and closes the dialog, or says why it could not.
   *
   * @remarks
   * See `NewChildDialog`.
   *
   * @sideEffects Sends the command; updates the dialog; closes the request on success.
   */
  const submit = async (): Promise<void> => {
    const named = name.trim() === "" ? "子对话" : name.trim();
    const where =
      place === "same" ? ({ place: "same" } as const) : ({ place: "worktree", branch: branch.trim() } as const);
    setBusy(true);
    setError(null);
    try {
      const made = await (request.turnId === null
        ? client.createChild(parent.containerId, { parentSessionId: parent.sessionId, name: named, ...where })
        : client.forkSession(parent.sessionId, request.turnId, named, where));
      pageNewChild().setState(null, true);
      // It works in its new worktree, but its model was not told so.
      if ("noteSent" in made) showNotice(made.sessionId, "没能告诉模型换了目录", true);
    } catch (failure) {
      const kept = keptChild(failure);
      if (kept === null) {
        setError(describeChildError(failure));
        setBusy(false);
        return;
      }
      // pi failed once it had written the child: it is there, under its parent, to be opened.
      pageNewChild().setState(null, true);
      showNotice(kept, "子对话没有开好", true);
      // Fire and forget: opening shows the session or its failure there.
      void client.openSession(kept).catch(() => undefined);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div
        data-testid="new-child-scrim"
        className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px] backdrop-saturate-[1.1]"
        onClick={busy ? undefined : () => pageNewChild().setState(null, true)}
      />
      <form
        role="dialog"
        aria-modal
        aria-labelledby="new-child-title"
        className="relative w-[380px] rounded-[var(--r-card)] bg-[var(--main)] p-5 shadow-[var(--card-shadow)]"
        onSubmit={(event) => {
          event.preventDefault();
          // Fire and forget: `submit` shows its own failure.
          if (!busy) void submit();
        }}
      >
        <h2 id="new-child-title" className="text-[15px] font-semibold">
          开子对话
        </h2>
        <p className="mt-1 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          {request.turnId === null ? `空的子对话，挂在「${title}」下` : `带上「${title}」到这一轮为止的对话`}
        </p>
        <label className="mt-3 block text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          名字
          <input
            ref={field}
            value={name}
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            className={`mt-1 ${FIELD}`}
          />
        </label>
        <div className="mt-3 text-[length:var(--fs-sm)] text-[var(--text-muted)]" id="new-child-place">
          放在
        </div>
        <div
          role="radiogroup"
          aria-labelledby="new-child-place"
          className="mt-1 inline-flex gap-0.5 rounded-[var(--r)] bg-[var(--surface-2)] p-0.5 dark:bg-[var(--main)]"
        >
          <button
            type="button"
            role="radio"
            aria-checked={place === "same"}
            className={CHOICE(place === "same")}
            onClick={() => setPlace("same")}
          >
            {inChat ? "当前对话" : "当前工作区"}
          </button>
          {onlyHere ? null : (
            <button
              type="button"
              role="radio"
              aria-checked={place === "worktree"}
              className={CHOICE(place === "worktree")}
              onClick={() => setPlace("worktree")}
            >
              新建 worktree
            </button>
          )}
        </div>
        {place === "worktree" ? (
          <>
            <label className="mt-3 block text-[length:var(--fs-sm)] text-[var(--text-muted)]">
              分支
              <input
                value={branch}
                maxLength={1024}
                onChange={(event) => setBranch(event.target.value)}
                className={`mt-1 ${FIELD}`}
              />
            </label>
            <p className="mt-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
              从当前工作区现在的提交开始；没提交的改动不带过去
            </p>
          </>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="mt-3 text-[length:var(--fs-meta)] leading-[1.55] text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => pageNewChild().setState(null, true)}
            className="h-[30px] rounded-[var(--r-btn)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-[30px] rounded-[var(--r-btn)] bg-[var(--text)] px-3 text-[length:var(--fs-meta)] text-[var(--main)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "正在开…" : "开子对话"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

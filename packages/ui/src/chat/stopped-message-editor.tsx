import { type AtriumClient, CommandError } from "@atrium/client";
import { useEffect, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import { finishStoppedEdit, type StoppedEdit, type StoppedEditState } from "../state/stopped-edits";
import { Composer, type ComposerProps, type SentImage } from "./composer";
import { compressImage } from "./images";
import { pageDrafts } from "../state/use-draft";

/** Props of the bottom stopped-message editor. */
interface StoppedMessageEditorProps {
  /** The connected host's image and revision commands. */
  readonly client: AtriumClient;
  /** The session whose last stopped message was selected. */
  readonly sessionId: string;
  /** The immutable transcript identity and separate local draft. */
  readonly target: StoppedEdit;
  /** Another operation currently prevents sending. */
  readonly blocked: boolean;
  /** The normal composer's upload and dropped-file capabilities. */
  readonly attaching: Partial<ComposerProps>;
  /** The model control, retained in its normal bottom-row position. */
  readonly picker: ComposerProps["picker"];
  /** Keeps target and request status alive while another session is shown. */
  readonly store: StoreApi<StoppedEditState>;
}

/**
 * Edits a stopped message in its own bottom draft, restoring every image before allowing submission.
 *
 * @remarks
 * SPEC-0001's selected A keeps the original bubble and next-message draft untouched. Failed image
 * reads/uploads leave placeholders and a retry, never a silently text-only revision. Identity is
 * captured at entry; stale loads after switching sessions or cancelling cannot change another draft.
 *
 * @sideEffects Reads and uploads message images; changes the private draft; submits the revision.
 * @param props - The captured target, session, upload controls, busy gate and page-local editor store.
 * @returns The editing composer and actionable error messages.
 */
export function StoppedMessageEditor({
  client,
  sessionId,
  target,
  blocked,
  attaching,
  picker,
  store,
}: StoppedMessageEditorProps) {
  const drafts = pageDrafts();
  const [restoring, setRestoring] = useState(target.images.length > 0);
  const [restoreError, setRestoreError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { submitting: busy, error } = useStore(store);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    // Fire and forget: restoration reports its own failure and never enables a partial submission.
    void (async () => {
      try {
        for (const kept of drafts.read(target.draftKey).images) {
          if (kept.attachmentId !== null) continue;
          const id = kept.id;
          const index = target.images.indexOf(id);
          // A newly added image still being compressed belongs to Composer's existing upload.
          if (kept.image === null && index === -1) continue;
          let image = kept.image;
          if (image === null) {
            const original = await client.fetchImage(sessionId, target.turnId, index);
            if (!current) return;
            const response = await fetch(`data:${original.mimeType};base64,${original.data}`, {
              signal: controller.signal,
            });
            image = await compressImage(await response.blob());
            if (!current) return;
            drafts.updateImage(id, (one) => ({ ...one, image }));
          }
          const { attachmentId } = await client.uploadAttachment(image.mimeType, image.data);
          if (!current) return;
          drafts.updateImage(id, (one) => ({ ...one, attachmentId }));
        }
        if (current) setRestoring(false);
      } catch {
        if (current) {
          setRestoring(false);
          setRestoreError(true);
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit retry reruns failed reads/uploads.
  }, [client, sessionId, target, drafts, attempt]);

  /**
   * Submits only once and leaves the private draft intact on failure.
   * @remarks The host revalidates the captured transcript; conflicts require explicit reconfirmation.
   * @sideEffects Sends the revision, updates page-local progress/error state and drops only the edit draft on success.
   * @param text - The edited body.
   * @param images - Every ready attachment still in the draft.
   */
  const submit = async (text: string, images: readonly SentImage[]): Promise<void> => {
    if (store.getState().submitting || blocked || restoring || restoreError) return;
    store.setState({ submitting: true, error: null });
    try {
      await client.editStoppedMessage(
        sessionId,
        target.epoch,
        target.turnId,
        text,
        images.map((one) => one.attachmentId),
      );
      finishStoppedEdit(store, target);
    } catch (failure) {
      if (store.getState().target !== target) return;
      if (failure instanceof CommandError && failure.code === "attachment_missing") {
        drafts.update(target.draftKey, (draft) => ({
          ...draft,
          images: draft.images.map((image) => ({ ...image, attachmentId: null })),
        }));
        // A fresh immutable context reruns restoration here, or when this session is shown again.
        store.setState({
          target: { ...target },
          submitting: false,
          error: "图片上传已过期，正在重新上传；完成后请重试",
        });
      } else {
        // Only this operation's confirmed restoration may refresh the captured CAS identity.
        const recoveredEpoch =
          failure instanceof CommandError &&
          failure.code === "edit_failed" &&
          failure.params?.["turnId"] === target.turnId &&
          typeof failure.params["epoch"] === "number"
            ? failure.params["epoch"]
            : null;
        store.setState({
          target: recoveredEpoch === null ? target : { ...target, epoch: recoveredEpoch },
          submitting: false,
          error:
            failure instanceof CommandError && failure.code === "transcript_changed"
              ? "对话记录已变化，请先复制编辑正文，再取消编辑并重新确认消息"
              : failure instanceof CommandError &&
                  failure.code === "edit_failed" &&
                  failure.params?.["status"] === "exited"
                ? "会话进程已停止，请先复制编辑正文，再取消编辑并重新打开会话"
                : "没能重新发送，编辑内容已保留，请重试",
        });
      }
    }
  };

  return (
    <>
      {restoring ? (
        <p
          role="status"
          className="mx-auto w-full max-w-[var(--column)] px-6 text-[length:var(--fs-sm)] text-[var(--text-muted)]"
        >
          正在恢复消息图片…
        </p>
      ) : null}
      {restoreError ? (
        <p
          role="alert"
          className="mx-auto w-full max-w-[var(--column)] px-6 text-[length:var(--fs-sm)] text-[color:color-mix(in_srgb,var(--danger)_85%,var(--text))]"
        >
          图片没能恢复，恢复全部图片后才能重新发送。
          <button
            type="button"
            onClick={() => {
              setRestoring(true);
              setRestoreError(false);
              setAttempt((one) => one + 1);
            }}
            className="ml-2 text-[var(--tint)]"
          >
            重试恢复图片
          </button>
        </p>
      ) : null}
      {error === null ? null : (
        <p
          role="alert"
          className="mx-auto w-full max-w-[var(--column)] px-6 text-[length:var(--fs-sm)] text-[color:color-mix(in_srgb,var(--danger)_85%,var(--text))]"
        >
          {error}
        </p>
      )}
      <Composer
        {...attaching}
        draftKey={target.draftKey}
        autoFocus
        picker={picker}
        onSend={() => undefined}
        editing={{
          busy,
          blocked: blocked || restoring || restoreError,
          savedDraft: target.savedDraft,
          onSubmit: submit,
          onCancel: () => {
            if (store.getState().submitting) return;
            finishStoppedEdit(store, target);
          },
        }}
      />
    </>
  );
}

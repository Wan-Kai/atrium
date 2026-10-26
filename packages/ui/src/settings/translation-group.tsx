import type { AtriumClient } from "@atrium/client";
import { useState } from "react";
import { useStore } from "zustand";
import { BUTTON, FIELD, Group, Row } from "./parts";

/**
 * The saved target language for translating agent replies.
 * @remarks The conversation always supplies the model. Draft edits do not affect translations
 * until the host has saved the preference; results stay in the mounted reply, not in storage.
 * @sideEffects Subscribes to preferences and sends `set_preferences` only on explicit save.
 * @param props - The client that owns the global preferences.
 * @returns The language setting and its pending, success or failure feedback.
 */
export function TranslationGroup({ client }: { readonly client: AtriumClient }) {
  const saved = useStore(client.index, (index) => index.preferences.translationLanguage);
  const [draft, setDraft] = useState({ base: saved, value: saved });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  if (draft.base !== saved) {
    setDraft({ base: saved, value: draft.value === draft.base ? saved : draft.value });
    setFeedback(null);
  }
  const language = draft.value.trim();
  const valid = language.length > 0 && language.length <= 80 && !/\p{Cc}/u.test(draft.value);
  const dirty = language !== saved;

  /**
   * Saves the trimmed language without changing the preference optimistically.
   * @remarks A failed command retains the draft for retry and leaves the saved language active.
   * @sideEffects Sends a preference command and changes local save feedback.
   */
  async function save(): Promise<void> {
    if (saving || !dirty || !valid) return;
    setSaving(true);
    setFeedback(null);
    try {
      await client.setPreferences({ translationLanguage: language });
      setDraft({ base: language, value: language });
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Group
      title="回复翻译"
      description="使用当前对话的模型翻译回复，不加入对话上下文。翻译会消耗模型额度，译文仅本次查看。"
    >
      <Row
        label="目标语言"
        controls={
          <>
            <input
              aria-label="翻译目标语言"
              value={draft.value}
              disabled={saving}
              placeholder="例如：简体中文、English、日本語"
              className={`${FIELD} w-40 disabled:opacity-50`}
              onChange={(event) => {
                setDraft({ base: saved, value: event.currentTarget.value });
                setFeedback(null);
              }}
            />
            <button
              type="button"
              aria-label="保存翻译语言"
              disabled={saving || !valid || !dirty}
              className={BUTTON}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {!valid ? (
          <p role="alert" className="mt-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
            请输入 1～80 个字符的目标语言，不含控制字符
          </p>
        ) : null}
        {feedback === "failed" ? (
          <p role="alert" className="mt-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
            没能保存翻译语言，请重试；当前语言没有改变
          </p>
        ) : null}
        {feedback === "saved" ? (
          <p role="status" className="mt-2 text-[length:var(--fs-sm)] text-[var(--ok-text)]">
            已保存
          </p>
        ) : null}
      </Row>
    </Group>
  );
}

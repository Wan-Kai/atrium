import {
  type AtriumClient,
  CommandError,
  PI_CONFIG_MAX_BYTES,
  PI_PROJECT_CONFIG_NAMES,
  PiConfigName,
} from "@atrium/client";
import type { PiConfigFile } from "@atrium/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BUTTON, FIELD, Group, PRIMARY_BUTTON } from "./parts";

/** The panel's draft protection, independent of configuration contents. */
export interface ConfigGuard {
  /** Whether navigating away would discard edits. */
  readonly dirty: boolean;
  /** Whether the host is saving. */
  readonly saving: boolean;
}

const GLOBAL_FILES = PiConfigName.options;
const PROJECT_FILES = PI_PROJECT_CONFIG_NAMES;

/**
 * Normalizes editor presentation without changing the original file bytes.
 * @remarks Textareas normalize CRLF themselves; a BOM is metadata, not editable content.
 * @sideEffects none
 * @param text - The original file contents.
 */
function displayText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * Restores the original encoding markers when the user edits a file.
 * @remarks Consistent CRLF is preserved; mixed line endings normalize to LF on edit.
 * @sideEffects none
 * @param text - The normalized draft.
 * @param original - The original file bytes decoded as UTF-8.
 */
function serialize(text: string, original: string): string {
  if (text === displayText(original)) return original;
  const crlf = original.includes("\r\n") && !original.replace(/\r\n/g, "").includes("\n");
  return (original.startsWith("\uFEFF") ? "\uFEFF" : "") + (crlf ? text.replace(/\n/g, "\r\n") : text);
}

/**
 * Checks syntax, root shape and the host's UTF-8 byte limit without exposing source text.
 * @remarks Configuration can contain manually entered secrets, including in malformed JSON.
 * @sideEffects none
 * @param text - The draft, never included in diagnostic messages.
 * @param name - The filename determining pi's accepted syntax.
 */
function validate(text: string, name: PiConfigName): string | null {
  if (new TextEncoder().encode(text).length > PI_CONFIG_MAX_BYTES) return "配置不能超过 256 KiB";
  if (name === "models.json") return null;
  const source = text.replace(/^\uFEFF/, "");
  if (name === "settings.json" && text === "") return null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return null;
  } catch {
    // Parse messages may echo credentials; only the fixed copy below is safe.
  }
  return "请输入有效的 JSON 对象";
}

/**
 * Translates config failures without displaying server or parser messages.
 * @remarks The draft remains in memory for recovery, never in persisted UI state.
 * @sideEffects none
 * @param error - A command failure; its message is not displayed.
 */
function describeFailure(error: unknown): string {
  if (error instanceof CommandError) {
    const messages: Partial<Record<CommandError["code"], string>> = {
      config_conflict: "文件已在别处修改，草稿已保留。请重新读取后再保存",
      config_invalid: "请输入有效的 JSON 对象",
      config_too_large: "配置不能超过 256 KiB",
      config_unavailable: "暂时无法取得 pi 的配置目录，请重试",
      config_encoding: "配置不是有效的 UTF-8，请用外部编辑器转换为 UTF-8 后重新读取",
      path_invalid: "配置路径不安全，无法读写",
      workspace_not_found: "当前工作区已不可用，请选择全局配置",
    };
    return messages[error.code] ?? "读写配置失败，请重试";
  }
  return "读写配置失败，请重试";
}

/**
 * Edits allowlisted ordinary pi files within settings, preserving their original text.
 * @remarks SPEC-0001 “设置 · pi”: credentials stay out of this editor; all destructive navigation
 * asks first, writes carry the read revision, and stale reads cannot replace the current file.
 * @sideEffects Reads and saves via the client; reports draft protection to the panel.
 * @param props - The client and callback receiving only dirty/saving flags, never file contents.
 */
export function PiConfigGroup({
  client,
  onGuard,
  requestNavigation,
  pending,
}: {
  readonly client: AtriumClient;
  readonly onGuard: (guard: ConfigGuard) => void;
  readonly requestNavigation: (action: () => void) => void;
  readonly pending: boolean;
}) {
  const workspaceId = useStore(client.index, (index) => {
    const selected = index.layout.container;
    return index.workspaces.some(
      (workspace) =>
        workspace.id === selected && workspace.archivedAt === null && workspace.merge?.verdict !== "removed",
    )
      ? selected
      : null;
  });
  const [selection, setSelection] = useState<{ scope: string | null; name: PiConfigName }>({
    scope: null,
    name: "settings.json",
  });
  const { scope, name } = selection;
  const [file, setFile] = useState<PiConfigFile | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "failed">("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const bytes = file === null ? text : serialize(text, file.text);
  const dirty = file !== null && bytes !== file.text;
  const saving = status === "saving";
  const invalid = file === null ? null : validate(bytes, name);

  useEffect(() => {
    onGuard({ dirty, saving });
  }, [dirty, saving, onGuard]);
  useEffect(() => () => onGuard({ dirty: false, saving: false }), [onGuard]);
  useEffect(() => {
    let active = true;
    // Fire and forget: both outcomes are handled, and cleanup invalidates the response.
    void client.readPiConfig(selection.scope, selection.name).then(
      (loaded) => {
        if (!active) return undefined;
        setFile(loaded);
        setText(displayText(loaded.text));
        setStatus("ready");
        return undefined;
      },
      (error: unknown) => {
        if (!active) return;
        setProblem(describeFailure(error));
        setStatus("failed");
      },
    );
    return () => {
      active = false;
    };
  }, [client, selection]);

  /**
   * Protects a draft before switching the file or rereading it.
   * @remarks Confirmation is inline, matching other settings confirmations.
   * @sideEffects Updates selection or the confirmation state.
   * @param action - The navigation to perform after confirmation.
   */
  function navigate(action: () => void): void {
    if (saveInFlight.current) return;
    requestNavigation(action);
  }

  /**
   * Clears the old file before requesting a different read.
   * @remarks A null file prevents saving the previous text against the new selection.
   * @sideEffects Resets editor state and schedules a read through selection state.
   * @param next - The next scope and file, or the current selection to reread.
   */
  function read(next = selection): void {
    if (saveInFlight.current) return;
    setFile(null);
    setText("");
    setStatus("loading");
    setProblem(null);
    setSelection({ ...next });
  }

  /**
   * Saves the exact text and its read revision, retaining drafts on failure.
   * @remarks Missing files can be created even without editing the host's default text.
   * @sideEffects Sends a save request and updates the editor state.
   */
  function save(): void {
    if (file === null || saveInFlight.current || pending || invalid !== null) return;
    saveInFlight.current = true;
    onGuard({ dirty, saving: true });
    setStatus("saving");
    setProblem(null);
    // Fire and forget: the panel stays open while both outcomes are handled here.
    void client.savePiConfig(scope, name, bytes, file.revision).then(
      (saved) => {
        saveInFlight.current = false;
        setFile(saved);
        setText(displayText(saved.text));
        setStatus("saved");
        return undefined;
      },
      (error: unknown) => {
        saveInFlight.current = false;
        setProblem(describeFailure(error));
        setStatus("failed");
      },
    );
  }

  return (
    <Group
      title="配置文件"
      description="直接编辑 pi 的普通配置。models.json 支持注释与尾逗号，保存时校验；其他文件使用 JSON 对象。密钥请优先引用环境变量；凭据在“模型与账户”管理。"
      footer="保存到 pi 的配置文件；已运行的会话不自动重载，新启动的 pi 按自身规则读取。项目配置需获得 pi 信任后生效。"
    >
      <div className="mx-3 space-y-2.5">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="配置作用域"
            className={FIELD}
            value={scope ?? "global"}
            disabled={saving}
            onChange={(event) => {
              const next = event.target.value;
              navigate(() => {
                read({
                  scope: next === "global" ? null : next,
                  name: next !== "global" && !PROJECT_FILES.includes(name) ? "settings.json" : name,
                });
              });
            }}
          >
            <option value="global">全局</option>
            <option value={workspaceId ?? "unavailable"} disabled={workspaceId === null}>
              当前工作区
            </option>
            {scope !== null && scope !== workspaceId ? (
              <option value={scope} disabled>
                工作区已不可用
              </option>
            ) : null}
          </select>
          <select
            aria-label="配置文件"
            className={`${FIELD} font-mono`}
            value={name}
            disabled={saving}
            onChange={(event) => {
              const next = GLOBAL_FILES.find((entry) => entry === event.target.value);
              if (next !== undefined) navigate(() => read({ scope, name: next }));
            }}
          >
            {(scope === null ? GLOBAL_FILES : PROJECT_FILES).map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        {workspaceId === null ? (
          <p className="text-[length:var(--fs-sm)] text-[var(--text-muted)]">选择项目工作区后可编辑项目配置。</p>
        ) : null}
        {file === null ? null : (
          <>
            <p className="break-all font-mono text-[length:var(--fs-sm)] text-[var(--text-2)]">{file.path}</p>
            {file.revision === null ? (
              <p className="text-[length:var(--fs-sm)] text-[var(--text-muted)]">文件尚不存在，保存时创建</p>
            ) : null}
            <textarea
              aria-label="配置内容"
              aria-invalid={invalid !== null}
              aria-describedby="pi-config-problem"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={text}
              disabled={saving}
              onChange={(event) => {
                setText(event.target.value);
                setProblem(null);
                setStatus("ready");
              }}
              className={`${FIELD} block min-h-64 w-full resize-y py-2 font-mono leading-relaxed`}
            />
          </>
        )}
        <div aria-live="polite" className="text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          {status === "loading"
            ? "正在读取配置…"
            : saving
              ? "正在保存配置…"
              : status === "saved"
                ? "已保存"
                : dirty
                  ? "未保存"
                  : null}
        </div>
        {problem !== null || invalid !== null ? (
          <p id="pi-config-problem" role="alert" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
            {problem ?? invalid}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={file === null || saving || pending || invalid !== null || (!dirty && file.revision !== null)}
            onClick={save}
          >
            保存配置
          </button>
          <button type="button" className={BUTTON} disabled={saving} onClick={() => navigate(() => read())}>
            {file === null && status === "failed" ? "重试读取" : "重新读取"}
          </button>
        </div>
      </div>
    </Group>
  );
}

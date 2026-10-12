import type { ConnectionState, RejectionReason } from "@atrium/client";

/** What the status line describes: the connection, or why there is none yet. */
export type StatusView =
  | ConnectionState
  | { readonly status: "starting" }
  | { readonly status: "unavailable" }
  | { readonly status: "bootstrap-failed" };

const REJECTION_TEXT: Record<RejectionReason, string> = {
  unauthorized: "宿主拒绝了连接：凭证不对",
  "version-mismatch": "宿主和界面的版本不一致，请重启 Atrium",
  "bad-handshake": "宿主拒绝了连接：握手消息无效",
  "handshake-timeout": "连接宿主超时",
  "rate-limited": "发送的消息太多，宿主断开了连接",
  "too-many-connections": "宿主的连接数已满",
};

/** Props of {@link ConnectionStatus}. */
export interface ConnectionStatusProps {
  /** State to describe. */
  readonly view: StatusView;
}

/**
 * Describes the connection to the host in one line, out of sight once connected.
 *
 * @remarks
 * The host sends codes, never user-facing text, so the wording lives here in the UI
 * (coding-standards.md, "多语言"). The main window shows it only while not connected; once
 * connected it is left to screen readers, and the settings' about shows the connection
 * (SPEC-0001, "同步与断线重连").
 *
 * @sideEffects none
 * @param props - The state to describe.
 * @returns The status line.
 */
export function ConnectionStatus({ view }: ConnectionStatusProps) {
  return (
    <p role="status" className={view.status === "connected" ? "sr-only" : "leading-6"} data-status={view.status}>
      {describeConnection(view)}
    </p>
  );
}

/**
 * Turns a status into Chinese text.
 *
 * @remarks
 * One place for the wording keeps it consistent and lets tests check every state; the settings'
 * about uses it too.
 *
 * @sideEffects none
 * @param view - The state.
 * @returns The sentence to show.
 */
export function describeConnection(view: StatusView): string {
  switch (view.status) {
    case "starting":
      return "正在启动…";
    case "unavailable":
      return "未在桌面应用中运行";
    case "bootstrap-failed":
      return "无法从桌面应用取得连接信息，请重启 Atrium";
    case "idle":
      return "尚未连接";
    case "connecting":
      return "正在连接宿主…";
    case "connected":
      return `已连接宿主 ${view.hostVersion}`;
    case "rejected":
      return REJECTION_TEXT[view.reason];
    case "reconnecting":
      return `与宿主的连接已断开，正在重连（第 ${view.attempt} 次）…`;
    case "disconnected":
      return "与宿主的连接已断开";
    default:
      return unreachable(view);
  }
}

/**
 * Marks a branch the type checker proves cannot happen.
 *
 * @remarks
 * Keeps the switch exhaustive at compile time and gives every path a return value.
 *
 * @sideEffects Throws if reached at runtime.
 * @param value - The value that should be `never`.
 * @returns Never returns.
 * @throws {Error} Always.
 */
function unreachable(value: never): never {
  throw new Error(`unexpected connection state ${JSON.stringify(value)}`);
}

import type { ConnectionState, RejectionReason } from "@atrium/client";

const REJECTION_TEXT: Record<RejectionReason, string> = {
  unauthorized: "宿主拒绝了连接：凭证不对",
  "version-mismatch": "宿主和界面的版本不一致，请重启 Atrium",
  "bad-handshake": "宿主拒绝了连接：握手消息无效",
  "handshake-timeout": "连接宿主超时",
};

/** Props of {@link ConnectionStatus}. */
export interface ConnectionStatusProps {
  /** State to describe; `null` when the page is not inside the desktop app. */
  readonly state: ConnectionState | null;
}

/**
 * Describes the connection to the host in one line.
 *
 * @remarks
 * The host sends codes, never user-facing text, so the wording lives here in the UI
 * (coding-standards.md, "多语言"). This is the whole M1.1 screen; the real layout replaces it.
 *
 * @sideEffects none
 * @param props - The state to describe.
 * @returns The status line.
 */
export function ConnectionStatus({ state }: ConnectionStatusProps) {
  return (
    <p role="status" className="text-muted-foreground" data-status={state?.status ?? "unavailable"}>
      {describe(state)}
    </p>
  );
}

/**
 * Turns a connection state into Chinese text.
 *
 * @remarks
 * One place for the wording keeps it consistent and lets tests check every state.
 *
 * @sideEffects none
 * @param state - The state, or `null` outside the desktop app.
 * @returns The sentence to show.
 */
function describe(state: ConnectionState | null): string {
  if (state === null) return "未在桌面应用中运行";
  switch (state.status) {
    case "idle":
      return "尚未连接";
    case "connecting":
      return "正在连接宿主…";
    case "connected":
      return `已连接宿主 ${state.hostVersion}`;
    case "rejected":
      return REJECTION_TEXT[state.reason];
    case "disconnected":
      return "与宿主的连接已断开";
    default:
      return unreachable(state);
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

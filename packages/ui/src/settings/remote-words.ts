import { CommandError, ConnectionLostError } from "@atrium/client";
import type { RemoteDevice, RemoteState } from "@atrium/protocol";

/** Recovery guidance without promising that the current process can repeat a denied keychain prompt. */
export const KEYCHAIN_HELP = "钥匙串暂时无法访问。请允许 Atrium 访问钥匙串；若此前拒绝授权，请重启 Atrium 后再试。";
/** An unreadable vault is not proof that the file itself is physically corrupt. */
export const VAULT_UNREADABLE = "保险箱文件损坏或密钥不匹配，当前无法读取。";

/**
 * Describes a remote command failure without exposing server text or credentials.
 * @remarks Only protocol codes reach the user; the original error can contain sensitive input.
 * @sideEffects none
 * @param error - The command failure.
 * @returns Recovery wording.
 */
export function remoteError(error: unknown): string {
  if (error instanceof ConnectionLostError) return "与宿主的连接断开，操作结果尚不确定。重新连接后检查状态再重试。";
  if (!(error instanceof CommandError)) return "操作未完成，请重试。";
  const words: Partial<Record<CommandError["code"], string>> = {
    remote_unavailable: "远程访问暂不可用，请检查开关、relay 和钥匙串授权。",
    keychain_unavailable: KEYCHAIN_HELP,
    vault_corrupt: `${VAULT_UNREADABLE}可在这台 Mac 的设置中重置。`,
    pairing_expired: "配对已结束，请重新出码。",
    pairing_busy: "已有一台手机等你确认，请先完成或拒绝它。",
    device_not_found: "这台设备已经不在列表里。",
    relay_unreachable: "连不上 relay，请检查网络、地址和 TLS 证书后重试。",
    relay_rejected: "relay 不认可宿主令牌，请粘贴 add-host 或 rotate-host 打印的新行。",
    invalid_message: "输入格式不正确，请检查后重试。",
    local_only: "只能在这台 Mac 上管理手机。",
  };
  return words[error.code] ?? "操作未完成，请重试。";
}

/**
 * Formats a host timestamp consistently in the user's local timezone.
 * @remarks Null means never reported, not the Unix epoch.
 * @sideEffects none
 * @param at - Epoch milliseconds or null.
 * @returns A short date and time.
 */
export function remoteDate(at: number | null): string {
  return at === null
    ? "尚未在线"
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
        at,
      );
}

/**
 * Describes the bytes per second beneath a node.
 * @remarks Both directions are added; no invented traffic is drawn into the line density.
 * @sideEffects none
 * @param bytes - Bytes per second.
 * @returns The rate or idle.
 */
export function remoteRate(bytes: number): string {
  if (bytes === 0) return "空闲";
  return bytes < 1024 ? `${Math.round(bytes)} B/s` : `${(bytes / 1024).toFixed(1)} KB/s`;
}

/**
 * Says whether a device can currently reach this host.
 * @remarks Stale online flags must not animate while remote access or the relay is off.
 * @sideEffects none
 * @param state - The whole remote state.
 * @returns Whether the relay is usable.
 */
export function remoteLive(state: RemoteState): boolean {
  return state.enabled && state.vault === "ok" && state.relay?.status === "connected";
}

/**
 * Describes a phone's actual connection and traffic.
 * @remarks Relay loss takes every device offline even before a later push updates each one.
 * @sideEffects none
 * @param device - The paired phone.
 * @param state - The host state.
 * @returns The node/list subtitle.
 */
export function deviceStatus(device: RemoteDevice, state: RemoteState): string {
  return remoteLive(state) && device.online
    ? `在线 · ${remoteRate(device.traffic.up + device.traffic.down)}`
    : `离线 · ${remoteDate(device.lastSeenAt)}`;
}

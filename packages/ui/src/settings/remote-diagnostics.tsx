import type { RemoteDiagnosticCheck, RemoteDiagnosticFailure, RemoteRelay } from "@atrium/protocol";
import { BUTTON, GHOST_BUTTON } from "./parts";

/** Labels reflect host evidence, not a guess based on the top-level connection error. */
const CHECK_WORDS: Record<RemoteDiagnosticCheck, string> = {
  passed: "已通过",
  failed: "未通过",
  unknown: "未知",
  not_applicable: "不适用",
};
/** Fixed failure wording; never interpolate a raw network error. */
const FAILURE_WORDS: Record<RemoteDiagnosticFailure, string> = {
  resolution_failed: "解析 relay 地址失败，请检查域名。",
  tcp_connect_failed: "无法建立到 relay 的 TCP 连接，请检查地址、端口和网络路径。",
  tls_failed: "TLS 连接失败，请检查 relay 的证书和反向代理。",
  websocket_upgrade_failed: "WebSocket 升级失败，请检查反向代理的升级配置。",
  token_rejected: "relay 拒绝了宿主令牌，请重新粘贴 add-host 或 rotate-host 打印的行。",
  timeout: "本次检查超时，未观察到的步骤仍为未知。",
  connection_closed: "检查期间连接关闭，请重试；不能据此判断哪一步失败。",
  unknown: "检查未完成，宿主没有更细的失败证据。",
};
/** The design's checklist order; network means TCP to this relay, not general Internet access. */
const STEPS = [
  ["network", "到 relay 的 TCP 连接"],
  ["resolution", "解析 relay 地址"],
  ["tls", "建立加密连接（TLS）"],
  ["token", "relay 认可宿主令牌"],
] as const;

/**
 * Renders the last completed relay check without inventing observations for untested stages.
 * @remarks Protocol 27 keeps old evidence during retry and clears it on configuration changes;
 * this component reads the snapshot directly so no local cache can resurrect old evidence.
 * @sideEffects Calls repair handlers on explicit user actions.
 * @param props - Relay snapshot, busy state and repair actions.
 * @returns Evidence and its timestamp, or an explicit absence of a finished check.
 */
export function RemoteDiagnostics({
  relay,
  busy,
  onRetry,
  onReplace,
}: {
  readonly relay: RemoteRelay;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onReplace: () => void;
}) {
  const diagnostics = relay.diagnostics;
  const failed = diagnostics?.failure != null || relay.error !== null;
  return (
    <section className="phone-diagnostics" aria-label="诊断清单">
      <h5>诊断</h5>
      {diagnostics === null ? (
        <>
          <p>尚无已完成的检查</p>
          {relay.error === null ? null : (
            <p className="phone-warning">
              {relay.error === "relay_rejected" ? FAILURE_WORDS.token_rejected : "连不上 relay，尚无细分诊断证据。"}
            </p>
          )}
        </>
      ) : (
        <>
          <p>{diagnostics.kind === "live" ? "当前控制连接活性检查" : "建立控制连接检查"}</p>
          <p>
            上次检查：
            <time dateTime={new Date(diagnostics.checkedAt).toISOString()}>
              {new Intl.DateTimeFormat("zh-CN", {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }).format(diagnostics.checkedAt)}
            </time>
          </p>
          {diagnostics.kind === "live" ? <p>本次未重新解析地址、建立 TLS 或认证令牌；未知不表示失败。</p> : null}
          {STEPS.map(([key, label]) => (
            <p key={key} data-check={key} data-result={diagnostics[key]}>
              <span aria-hidden="true">
                {diagnostics[key] === "passed" ? "✓" : diagnostics[key] === "failed" ? "×" : "—"}
              </span>
              <span>{label}</span>
              <small>{CHECK_WORDS[diagnostics[key]]}</small>
            </p>
          ))}
          {diagnostics.failure === null ? null : <p className="phone-warning">{FAILURE_WORDS[diagnostics.failure]}</p>}
        </>
      )}
      {failed ? (
        <>
          <button type="button" className={BUTTON} disabled={busy} onClick={onRetry}>
            现在重试
          </button>
          <button type="button" className={GHOST_BUTTON} disabled={busy} onClick={onReplace}>
            重新粘贴
          </button>
        </>
      ) : null}
    </section>
  );
}

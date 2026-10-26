import type { RemotePairing } from "@atrium/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import { CheckCircle, Phone, X } from "../design/icons";
import { useClock } from "../state/clock";
import { BUTTON, PRIMARY_BUTTON } from "./parts";

/**
 * Renders a real QR code without putting its secret in DOM attributes or external requests.
 * @remarks Four modules of quiet zone and high contrast keep the one-time code scannable.
 * @sideEffects none
 * @param props - The host's one-time pairing URI.
 * @returns A vector code, not the prototype's decorative pseudo-code.
 */
function PairingQr({ value }: { readonly value: string }) {
  const qr = useMemo(() => encode(value, { ecc: "M", border: 4 }), [value]);
  return (
    <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="一次性配对二维码" shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="white" />
      <path
        fill="#1d1d1f"
        d={qr.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("")}
      />
    </svg>
  );
}

/**
 * Shows the host-authoritative pairing flow beneath the map.
 * @remarks Expiry affects only available QR codes; awaiting confirmation has its own host deadline.
 * The protocol exposes no pre-confirmation handshake stage, so the UI does not invent one.
 * @sideEffects Focuses the dialog, schedules the countdown while a QR is valid, restores prior focus;
 * handlers send commands. Captures Escape and traps Tab inside the sheet.
 * @param props - The current pairing, pending state, error content and commands.
 * @returns The anchored pairing sheet.
 */
export function RemotePairingDialog({
  pairing,
  busy,
  online,
  onClose,
  onRefresh,
  onConfirm,
  error,
}: {
  readonly pairing: RemotePairing;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onConfirm: (accept: boolean) => void;
  readonly error: string | null;
}) {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (pairing.state !== "available") return undefined;
    return clock.every(1000, () => setNow(clock.now()));
  }, [clock, pairing.state]);
  useEffect(() => {
    /**
     * Gives pairing Escape priority over the outer settings window.
     * @remarks The settings panel may receive initial focus after this child mounts.
     * @sideEffects Stops propagation and requests cancellation.
     * @param event - The keyboard event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [busy, onClose]);
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  const expired = pairing.state === "expired" || (pairing.state === "available" && seconds === 0);
  const handshaking = online && pairing.state === "available" && pairing.handshaking && !expired;
  const done = pairing.state === "committed";
  const request = pairing.request;
  const confirming = pairing.state === "awaiting_confirmation";
  const title = handshaking
    ? "等手机确认密钥"
    : done
      ? "已配对"
      : confirming
        ? "核对校验码"
        : expired
          ? "二维码已过期"
          : pairing.state === "rejected"
            ? "没能配对"
            : "配对新设备";
  const reason = {
    cancelled: "这次配对已取消",
    declined: "你已拒绝这台手机",
    timeout: "等待确认超时",
    disconnected: "手机在确认前断开了",
    vault_failed: "没能写入保险箱，请检查钥匙串后重新配对",
  };
  return (
    <div className="phone-pair-overlay">
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="配对新设备"
        className="phone-pair-sheet"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="phone-pair-steps">
          <span data-active={!confirming && !done && !handshaking}>1. 扫码</span>
          <i />
          <span data-active={confirming || handshaking}>2. 核对校验码</span>
          <i />
          <span data-active={done}>3. 完成</span>
        </div>
        <h3 aria-label={title}>
          {title}
          <button type="button" aria-label="关闭配对" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </h3>
        {done ? (
          <p className="phone-pair-request">
            <CheckCircle size={24} />
            配对成功，手机已加入设备列表。
          </p>
        ) : confirming && request !== null ? (
          <>
            <div className="phone-pair-request">
              <Phone size={22} />
              <div>
                <b>{request.deviceName} 请求配对</b>
                <small>{request.model} · 密钥已确认 · 2 分钟内确认</small>
              </div>
            </div>
            <p>手机上也显示了一串数字。一致再确认，不一致就拒绝。</p>
            <div className="phone-pair-code" aria-label={`校验码 ${request.sas.slice(0, 3)} ${request.sas.slice(3)}`}>
              {request.sas.split("").map((digit, index) => (
                <span key={index} className={index === 3 ? "second-half" : ""}>
                  {digit}
                </span>
              ))}
            </div>
          </>
        ) : pairing.state === "rejected" ? (
          <p role="status">{pairing.reason === null ? "配对已结束，请重新出码" : reason[pairing.reason]}</p>
        ) : expired ? (
          <p>这个码已经作废。刷新后在 iPhone 上重新扫码。</p>
        ) : (
          <div className="phone-pair-qr">
            <div className="phone-qr-frame" data-handshaking={handshaking}>
              <PairingQr value={pairing.qr} />
              {handshaking ? <span>正在确认密钥</span> : null}
            </div>
            <div>
              <p className="phone-countdown" role="timer">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} 后过期
              </p>
              <p>
                {handshaking
                  ? "正在等待手机用握手后的密钥确认。此时还不能确认手机身份，也未授予访问权限。"
                  : "在 iPhone 上打开 Atrium，用它的扫码界面扫这个码。"}
              </p>
              <small>5 分钟内有效，只能用一次。码里有一次性密钥，别发给别人，也别截图分享。</small>
              <p className="phone-pair-wait">
                {handshaking ? "确认通过后才会显示校验码；二维码原期限不变。" : "等待手机扫码并确认密钥…"}
              </p>
            </div>
          </div>
        )}
        {pairing.refused > 0 ? (
          <p className="phone-refused">
            另一台手机也扫了这个码，已拒绝{pairing.refused > 1 ? `（${pairing.refused} 次）` : ""}
          </p>
        ) : null}
        {!online ? (
          <p role="alert" className="phone-error">
            与宿主连接已断开，请重连后继续核对。关闭窗口不会取消宿主上的配对，它仍会按时过期。
          </p>
        ) : null}
        {error === null ? null : (
          <p className="phone-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          {confirming ? (
            <>
              <button className={BUTTON} type="button" disabled={busy || !online} onClick={() => onConfirm(false)}>
                拒绝
              </button>
              <button
                className={PRIMARY_BUTTON}
                type="button"
                disabled={busy || !online || request === null}
                onClick={() => onConfirm(true)}
              >
                {busy ? "正在处理…" : "确认配对"}
              </button>
            </>
          ) : (
            <>
              <button className={BUTTON} type="button" disabled={busy} onClick={onClose}>
                {done ? "完成" : "取消"}
              </button>
              {expired || pairing.state === "rejected" ? (
                <button className={PRIMARY_BUTTON} type="button" disabled={busy || !online} onClick={onRefresh}>
                  刷新二维码
                </button>
              ) : null}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

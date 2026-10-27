import type { AtriumClient } from "@atrium/client";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Check, Copy, PencilSimple, Phone, Plus, Trash, WarningCircle } from "../design/icons";
import { RenameField } from "../sidebar/rename-field";
import { useClock } from "../state/clock";
import { BUTTON, FIELD, GHOST_BUTTON, PRIMARY_BUTTON, Row } from "./parts";
import { deviceStyle, RemoteLinkMap } from "./remote-link-map";
import { RemotePairingDialog } from "./remote-pairing";
import { RemoteDiagnostics } from "./remote-diagnostics";
import { PhoneNotice } from "./phone-notice";
import type { PendingRevocations } from "./pending-revocations";
import { deviceStatus, remoteDate, remoteError, remoteLive, KEYCHAIN_HELP, VAULT_UNREADABLE } from "./remote-words";
import "./phone-section.css";

/** A replayable operation, retained for explicit retry, never automatically replayed. */
interface RemoteAction {
  readonly perform: () => Promise<unknown>;
  readonly success: string;
  readonly done?: () => void;
  readonly revoke?: boolean;
}

/**
 * Shows the desktop Phone settings using the enclosing settings window's remote watch.
 * @remarks SPEC-0005: all changes are authoritative host pushes; commands never optimistically
 * grant access. A failed revoke retains its id so retry remains possible after the host hides it.
 * @sideEffects Subscribes to remote state; sends commands on user actions; copies only
 * the public fingerprint; releases local timers and mounted guards on unmount, not the watch.
 * @param props - The client, read-retry handler and window-owned failed revocation targets.
 * @returns The link map, node details, full device list and pairing sheet.
 */
export function PhoneSection({
  client,
  onRetryRemote,
  revocations,
}: {
  readonly client: AtriumClient;
  readonly onRetryRemote: () => void;
  readonly revocations: PendingRevocations;
}) {
  const view = useStore(client.remote);
  const connected = useStore(client.connection, (connection) => connection.status === "connected");
  const [selected, setSelected] = useState("relay");
  const [hover, setHover] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editingRelay, setEditingRelay] = useState(false);
  const [relayLine, setRelayLine] = useState("");
  const [dismissedPair, setDismissedPair] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; action: RemoteAction } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const list = useRef<HTMLElement>(null);
  const clock = useClock();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!copied) return undefined;
    return clock.after(2000, () => setCopied(false));
  }, [clock, copied]);

  /**
   * Runs one explicit user action and keeps failures retryable.
   * @remarks A synchronous guard prevents double activation before React disables the controls.
   * @sideEffects Sends the command; updates feedback only while mounted.
   * @param action - The operation, success wording and completion transition.
   */
  const run = useCallback((action: RemoteAction): void => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    // Fire and forget: both outcomes are handled here, without exposing raw error text.
    void action
      .perform()
      .then(
        () => {
          if (!mounted.current) return undefined;
          setNotice(action.success);
          action.done?.();
          return undefined;
        },
        (error: unknown) => {
          if (!mounted.current) return;
          // Revocation failures belong to the settings window, independently of this action's feedback.
          if (action.revoke) return;
          setFailure({ text: remoteError(error), action });
        },
      )
      .finally(() => {
        pending.current = false;
        if (mounted.current) setBusy(false);
      });
  }, []);
  const state = view.state;
  const pairing = state?.pairing ?? null;
  const showPair = pairing !== null && pairing.pairingId !== dismissedPair;
  const disabled = busy || !connected || view.status !== "ready";

  /** Starts or refreshes the one-time pairing. @remarks The host supplies QR and expiry. @sideEffects Sends start_pairing and opens the sheet. */
  const start = (): void =>
    run({ perform: () => client.startPairing(), success: "二维码已生成", done: () => setDismissedPair(null) });
  /** Clears the current pairing. @remarks Failure leaves the dialog open for retry. @sideEffects Sends cancel_pairing and closes only on success. */
  const closePair = (): void => {
    if (!connected || view.status !== "ready") {
      setDismissedPair(pairing?.pairingId ?? null);
      return;
    }
    run({ perform: () => client.cancelPairing(), success: "配对窗口已关闭" });
  };
  /**
   * Selects node details.
   * @remarks Moving nodes cancels only local edits, never a host operation.
   * @sideEffects Updates selection and editor state.
   * @param id - Node identity.
   */
  const select = (id: string): void => {
    if (id === "pair") {
      setDismissedPair(null);
      return;
    }
    setSelected(id);
    setConfirm(null);
    setRenaming(null);
  };
  /**
   * Sends a device rename.
   * @remarks Empty restores the phone-reported name.
   * @sideEffects Sends rename_device and clears local editor.
   * @param id - Device identity.
   * @param name - New name or cancellation.
   */
  const rename = (id: string, name: string | null | undefined): void => {
    setRenaming(null);
    if (name === undefined) return;
    if ((name?.length ?? 0) > 64) {
      setNotice("名字最多 64 个字符，请重新改名");
      return;
    }
    run({ perform: () => client.renameDevice(id, name ?? ""), success: "设备名字已保存" });
  };
  /** Tests the saved relay. @remarks An established socket is probed in place; success promises only control-link reachability. @sideEffects Sends test_relay. */
  const test = (): void =>
    run({ perform: () => client.testRelay(), success: "relay 控制链路检查通过，不代表手机或 pi 可用" });
  /** Saves a relay line without retaining the token after success. @remarks Replacing an address requires pairing again. @sideEffects Sends set_remote and clears the local secret field. */
  const saveRelay = (): void =>
    run({
      // Public identity changes invalidate retries via the window observer; token-only saves must not.
      perform: () => client.setRemote(true, relayLine.trim()),
      success: "relay 已保存；地址或宿主 id 改变后，所有手机都要重新扫码配对",
      done: () => {
        setRelayLine("");
        setEditingRelay(false);
      },
    });
  /** Regenerates identity after explicit confirmation. @remarks Also recovers corrupt vaults; never automatic. @sideEffects Sends reset_remote_identity. */
  const reset = (): void =>
    run({
      perform: async () => {
        const finish = revocations.beginIdentityChange();
        await client.resetRemoteIdentity();
        finish();
      },
      success: "已撤销全部设备，宿主密钥已重新生成",
      done: () => setConfirm(null),
    });
  const feedback = (
    <>
      {revocations.entries.map((entry) => (
        <div className="phone-error" role="alert" aria-label={`撤销 ${entry.name}`} key={entry.deviceId}>
          <WarningCircle size={15} />
          <span>
            {entry.name}：{entry.error}
          </span>
          <button
            type="button"
            className={BUTTON}
            aria-label={`重试撤销 ${entry.name}`}
            disabled={disabled || entry.pending}
            onClick={() =>
              run({
                perform: () => revocations.revoke(entry.deviceId, entry.name),
                success: `已撤销「${entry.name}」`,
                revoke: true,
              })
            }
          >
            {entry.pending ? "正在重试…" : "重试撤销"}
          </button>
        </div>
      ))}
      {failure === null ? null : (
        <div className="phone-error" role="alert">
          <WarningCircle size={15} />
          <span>{failure.text}</span>
          <button className={BUTTON} disabled={disabled} type="button" onClick={() => run(failure.action)}>
            重试操作
          </button>
        </div>
      )}
      {notice === null ? null : <PhoneNotice key={notice} text={notice} onGone={() => setNotice(null)} />}
    </>
  );
  if (state === null)
    return (
      <section className="phone-settings" aria-label="手机设置">
        {view.status === "failed" ? (
          <div role="alert">
            <p>{remoteError(view.error)}</p>
            <button type="button" className={BUTTON} onClick={onRetryRemote}>
              重新读取
            </button>
          </div>
        ) : (
          <p role="status">正在读取远程访问状态…</p>
        )}
      </section>
    );
  const device = state.devices.find((item) => item.deviceId === selected);
  const detailStyle: CSSProperties & { "--node-x": string } = {
    "--node-x": selected === "mac" ? "11.54%" : device !== undefined ? "72.44%" : "42.95%",
  };
  const fingerprint =
    state.hostFingerprint
      ?.toUpperCase()
      .match(/.{1,4}/g)
      ?.join(" ") ?? "尚未生成";
  const live = remoteLive(state);
  const vaultReadable = state.vault === "ok";
  const vaultWords = {
    unread: "打开远程访问后才读取保险箱",
    waiting: "等待钥匙串授权，请在 macOS 弹窗中允许 Atrium",
    ok: "",
    keychain_unavailable: KEYCHAIN_HELP,
    corrupt: `${VAULT_UNREADABLE}重置会替换原宿主身份，所有手机都要重新配对。`,
    unavailable: "宿主未在 Electron 中运行，远程访问不可用",
  };
  const details: ReactNode =
    selected === "mac" ? (
      <>
        <h4>这台 Mac</h4>
        <Row
          label="允许手机远程访问"
          detail="宿主只主动连出去，不开端口"
          controls={
            <button
              type="button"
              role="switch"
              aria-label="允许手机远程访问"
              aria-checked={state.enabled}
              disabled={disabled || state.vault === "waiting" || state.vault === "unavailable"}
              className="phone-switch"
              onClick={() =>
                run({
                  perform: () => client.setRemote(!state.enabled),
                  success: state.enabled ? "远程访问已关闭" : "远程访问已打开",
                })
              }
            />
          }
        />
        <Row
          compact
          label="宿主公钥指纹"
          detail="私钥在保险箱里，由 macOS 钥匙串保护"
          controls={
            <>
              <code>{fingerprint}</code>
              <button
                type="button"
                className="phone-icon"
                aria-label={copied ? "已复制指纹" : "复制指纹"}
                disabled={state.hostFingerprint === null || busy}
                onClick={() =>
                  run({
                    perform: () => navigator.clipboard.writeText(fingerprint),
                    success: "已复制",
                    done: () => setCopied(true),
                  })
                }
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </>
          }
        />
        <Row
          label="撤销全部并重新生成宿主密钥"
          detail={
            vaultReadable
              ? "所有手机都要重新配对，relay 上的宿主令牌不变"
              : "当前无法读取保险箱；无法恢复时需重新填写 relay 配置"
          }
          controls={
            <button
              className={BUTTON}
              type="button"
              disabled={
                disabled || state.vault === "waiting" || state.vault === "unread" || state.vault === "unavailable"
              }
              onClick={() => setConfirm("reset")}
            >
              撤销全部…
            </button>
          }
        />
        {confirm === "reset" ? (
          <div className="phone-confirm">
            <p>
              {vaultReadable
                ? `${state.devices.length} 台设备将断开，原宿主身份与设备记录将永久替换，所有手机都需要重新配对。确认重新生成？`
                : "已配对设备数量未知。当前无法读取保险箱；继续会永久替换原宿主身份与设备记录，所有手机都需要重新配对。确认重置？"}
            </p>
            <button type="button" className={GHOST_BUTTON} disabled={disabled} onClick={() => setConfirm(null)}>
              取消
            </button>
            <button type="button" className={BUTTON} disabled={disabled} onClick={reset}>
              撤销全部并重新生成
            </button>
          </div>
        ) : null}
      </>
    ) : device !== undefined ? (
      <>
        <h4>
          {renaming === device.deviceId ? (
            <RenameField
              initial={device.name}
              label="设备名字"
              restores="清空恢复为手机的名字"
              onDone={(name) => rename(device.deviceId, name)}
            />
          ) : (
            <>
              {device.name}
              <button
                type="button"
                className="phone-icon"
                aria-label="改名"
                disabled={disabled}
                onClick={() => setRenaming(device.deviceId)}
              >
                <PencilSimple size={13} />
              </button>
            </>
          )}
        </h4>
        <Row compact label="状态" controls={deviceStatus(device, state)} />
        <Row compact label="型号" detail="配对时由手机自报，不是硬件认证" controls={device.model ?? "宿主未提供"} />
        <Row compact label="配对时间" controls={remoteDate(device.pairedAt)} />
        <Row compact label="最后在线" controls={device.online && live ? "现在" : remoteDate(device.lastSeenAt)} />
        <Row
          label="撤销这台设备"
          detail="它会立刻断开，再用要重新扫码配对"
          controls={
            <button className={BUTTON} type="button" disabled={disabled} onClick={() => setConfirm(device.deviceId)}>
              撤销
            </button>
          }
        />
        {confirm === device.deviceId ? (
          <div className="phone-confirm">
            <p>撤销后 {device.name} 再用要重新扫码配对。</p>
            <button className={GHOST_BUTTON} type="button" disabled={disabled} onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              className={BUTTON}
              type="button"
              disabled={disabled}
              onClick={() =>
                run({
                  perform: () => revocations.revoke(device.deviceId, device.name),
                  success: `已撤销「${device.name}」`,
                  revoke: true,
                  done: () => {
                    setSelected("relay");
                    setConfirm(null);
                  },
                })
              }
            >
              确认撤销
            </button>
          </div>
        ) : null}
      </>
    ) : (
      <>
        <h4>{state.relay === null ? "接上你的 relay" : "relay"}</h4>
        <Row
          compact
          label="连接"
          detail={state.relay?.url ?? "在 VPS 上运行 atrium-relay add-host，粘贴它打印的那一行"}
          controls={
            live ? "已连接" : !state.enabled ? "已关闭" : state.relay?.status === "connecting" ? "正在连接" : "未连接"
          }
        />
        {state.relay === null ? null : (
          <RemoteDiagnostics
            relay={state.relay}
            busy={disabled}
            onRetry={test}
            onReplace={() => setEditingRelay(true)}
          />
        )}
        {editingRelay || state.relay === null ? (
          <div className="phone-relay-edit">
            <label htmlFor="phone-relay-line">relay 的那一行</label>
            <input
              id="phone-relay-line"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={FIELD}
              value={relayLine}
              onChange={(event) => setRelayLine(event.target.value)}
              placeholder="atrium-relay://hst_…:令牌@relay.example.com"
              disabled={disabled}
            />
            <p className="phone-warning">换了 relay 地址或宿主 id，所有手机都要重新扫码配对；只换令牌不用。</p>
            <div>
              <button
                className={PRIMARY_BUTTON}
                type="button"
                disabled={disabled || relayLine.trim() === ""}
                onClick={saveRelay}
              >
                保存并连接
              </button>
              {state.relay === null ? null : (
                <button
                  className={GHOST_BUTTON}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setEditingRelay(false);
                    setRelayLine("");
                  }}
                >
                  取消
                </button>
              )}
            </div>
          </div>
        ) : (
          <Row
            compact
            label="relay 的那一行"
            detail="令牌只进不出，不再显示"
            controls={
              <>
                <code className="phone-masked" title="令牌不会回传">
                  atrium-relay://{state.relay.hostId.slice(0, 8)}…:••••••@{state.relay.url.replace(/^wss?:\/\//, "")}
                </code>
                <button
                  type="button"
                  className={GHOST_BUTTON}
                  disabled={disabled}
                  onClick={() => setEditingRelay(true)}
                >
                  替换
                </button>
              </>
            }
          />
        )}
        <Row
          compact
          label="测试连接"
          detail="已连接时原地探测控制链路，不会为测试挤掉手机；断线时重新连接"
          controls={
            <button type="button" className={BUTTON} disabled={disabled || state.relay === null} onClick={test}>
              {busy ? "正在处理…" : "测试连接"}
            </button>
          }
        />
      </>
    );
  return (
    <section className="phone-settings" aria-label="手机设置" data-hover={hover ?? undefined}>
      {!connected ? (
        <p role="alert" className="phone-error">
          与宿主的连接已断开，以下是上次状态；重连后自动刷新。
        </p>
      ) : null}
      {view.status === "failed" ? (
        <p className="phone-error" role="alert">
          {remoteError(view.error)}
          <button type="button" className={BUTTON} onClick={onRetryRemote}>
            重新读取
          </button>
        </p>
      ) : null}
      <RemoteLinkMap
        state={connected && view.status === "ready" ? state : { ...state, enabled: false }}
        selected={selected}
        hover={hover}
        onHover={setHover}
        onSelect={select}
        onMore={() => list.current?.scrollIntoView({ block: "start", behavior: "instant" })}
      />
      <div className="phone-below-map">
        <div inert={showPair}>
          {feedback}
          {state.vault !== "ok" && state.vault !== "unread" ? (
            <div className="phone-vault" role={state.vault === "waiting" ? "status" : "alert"}>
              <p>{vaultWords[state.vault]}</p>
              {state.vault === "corrupt" ? (
                <button
                  type="button"
                  className={BUTTON}
                  disabled={disabled}
                  onClick={() => {
                    setSelected("mac");
                    setConfirm("reset");
                  }}
                >
                  重置
                </button>
              ) : state.vault === "keychain_unavailable" ? (
                <button type="button" className={BUTTON} disabled={disabled} onClick={onRetryRemote}>
                  刷新状态
                </button>
              ) : null}
            </div>
          ) : null}
          <section className="phone-details" aria-label="节点详情" style={detailStyle}>
            {details}
          </section>
          <section ref={list} className="phone-device-list" aria-label="设备列表">
            <h4>
              设备 <small>{vaultReadable ? `${state.devices.length} 台` : "数量未知"}</small>
              <button type="button" className={BUTTON} disabled={disabled || !live} onClick={start}>
                <Plus size={13} />
                配对新设备
              </button>
            </h4>
            {state.devices.length === 0 ? (
              <p className="phone-empty">
                {live ? "还没有配对的设备。在 iPhone 上装好 Atrium，点“配对新设备”。" : "连上 relay 后才能配对手机。"}
              </p>
            ) : (
              state.devices.map((item) => (
                <div
                  key={item.deviceId}
                  data-testid={`device-${item.deviceId}`}
                  className="phone-device-row"
                  style={deviceStyle(item.deviceId)}
                  data-device={item.deviceId}
                  data-dim={hover !== null && hover !== item.deviceId}
                  onPointerEnter={() => setHover(item.deviceId)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(item.deviceId)}
                  onBlur={() => setHover(null)}
                >
                  {renaming === `list:${item.deviceId}` ? (
                    <div className="phone-device-open">
                      <span className="phone-device-tile">
                        <Phone size={16} />
                      </span>
                      <RenameField
                        initial={item.name}
                        label="设备名字"
                        restores="清空恢复为手机的名字"
                        onDone={(name) => rename(item.deviceId, name)}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="phone-device-open"
                      aria-label={`查看 ${item.name}`}
                      onClick={() => select(item.deviceId)}
                    >
                      <span className="phone-device-tile">
                        <Phone size={16} />
                      </span>
                      <span>
                        <b>{item.name}</b>
                        <small>
                          {deviceStatus(item, state)} · {remoteDate(item.pairedAt)}配对
                        </small>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="phone-icon"
                    aria-label={`改名 ${item.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setSelected(item.deviceId);
                      setRenaming(`list:${item.deviceId}`);
                    }}
                  >
                    <PencilSimple size={13} />
                  </button>
                  <button
                    type="button"
                    className="phone-icon"
                    aria-label={`撤销 ${item.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setSelected(item.deviceId);
                      setConfirm(item.deviceId);
                    }}
                  >
                    <Trash size={13} />
                  </button>
                </div>
              ))
            )}
          </section>
        </div>
        {showPair && pairing !== null ? (
          <RemotePairingDialog
            pairing={pairing}
            busy={busy}
            online={connected && view.status === "ready"}
            onClose={closePair}
            onRefresh={start}
            onConfirm={(accept) =>
              run({
                perform: () => client.confirmPairing(pairing.pairingId, accept),
                success: accept ? "配对已确认" : "已拒绝配对",
              })
            }
            error={failure?.text ?? null}
          />
        ) : null}
      </div>
    </section>
  );
}

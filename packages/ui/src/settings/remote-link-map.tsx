import type { RemoteState } from "@atrium/protocol";
import { type CSSProperties, useEffect, useState } from "react";
import { Cloud, Laptop, Lock, Phone, WarningCircle } from "../design/icons";
import { useClock } from "../state/clock";
import { deviceColor, lanePoint, packetFrame } from "./remote-map";
import { deviceStatus, remoteLive, remoteRate } from "./remote-words";

/**
 * Builds a device colour style shared by lanes, nodes and list rows.
 * @remarks The CSS supplies the five light/dark pairs from the approved prototype.
 * @sideEffects none
 * @param id - Device identity.
 * @returns A custom property for the device colour.
 */
export function deviceStyle(id: string): CSSProperties & { "--device-color": string } {
  return { "--device-color": `var(--phone-${deviceColor(id)})` };
}

/**
 * Draws the single packet style, with fade at both ends of its segment.
 * @remarks Packets disappear inside the nodes; merging and splitting are never visible outside relay.
 * @sideEffects none
 * @param props - Position, colour and progress along the segment.
 * @returns A solid 6.5px dot and soft glow.
 */
function Packet({
  x,
  y,
  fraction,
  color,
}: {
  readonly x: number;
  readonly y: number;
  readonly fraction: number;
  readonly color: string;
}) {
  const opacity = Math.min(1, fraction * 7, (1 - fraction) * 7);
  return (
    <g className="phone-packet" transform={`translate(${x} ${y})`} fill={color} opacity={opacity}>
      <circle r="6.5" className="phone-packet-glow" />
      <circle r="3.25" />
    </g>
  );
}

/**
 * Draws the Mac—relay—phones link map.
 * @remarks Geometry and the 3900ms sequence follow mobile-pairing-linkmap-prototype; at most four
 * devices are drawn. Reduced motion uses static arrows and starts no animation clock.
 * @sideEffects Subscribes to reduced-motion/visibility changes and schedules a clock while visible;
 * calls selection and hover handlers. All resources stop on unmount.
 * @param props - Host state, selection, shared hover identity and navigation handlers.
 * @returns The interactive map.
 */
export function RemoteLinkMap({
  state,
  selected,
  hover,
  onHover,
  onSelect,
  onMore,
}: {
  readonly state: RemoteState;
  readonly selected: string;
  readonly hover: string | null;
  readonly onHover: (id: string | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onMore: () => void;
}) {
  const clock = useClock();
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [elapsed, setElapsed] = useState(0);
  const live = remoteLive(state);
  const online = state.devices.some((device) => device.online);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    /** Updates the motion preference. @remarks Stops running animation clocks immediately. @sideEffects Updates React state. */
    const change = (): void => setReduced(media.matches);
    /** Suspends motion in background windows. @remarks Saves work with no visible map. @sideEffects Updates React state. */
    const visibility = (): void => setVisible(!document.hidden);
    media.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (reduced || !visible || !live || !online) return undefined;
    const start = clock.now();
    return clock.every(16, () => setElapsed(clock.now() - start));
  }, [clock, reduced, visible, live, online]);
  const frame = packetFrame(elapsed);
  const moving = live && online && !reduced;
  const devices = state.devices.toSorted((a, b) => Number(b.online) - Number(a.online));
  const hidden = devices.slice(4);
  const pairing = state.pairing !== null && ["available", "awaiting_confirmation"].includes(state.pairing.state);
  const slots = [
    ...devices.slice(0, 4).map((device) => ({
      id: device.deviceId,
      name: device.name,
      sub: deviceStatus(device, state),
      online: live && device.online,
      device,
    })),
    ...(hidden.length === 0
      ? []
      : [
          {
            id: "more",
            name: `还有 ${hidden.length} 台`,
            sub: "在下面的列表里",
            online: live && hidden.some((device) => device.online),
            device: null,
          },
        ]),
    ...(pairing
      ? [
          {
            id: "pair",
            name: state.pairing?.request?.deviceName || "配对中",
            sub: state.pairing?.state === "awaiting_confirmation" ? "等你确认" : "等手机扫码",
            online: false,
            device: null,
          },
        ]
      : []),
  ].map((slot, index, all) => ({
    ...slot,
    y: 112 + (index - (all.length - 1) / 2) * Math.min(46, 184 / Math.max(1, all.length - 1)),
  }));
  const broken = state.enabled && state.relay?.error !== null && state.relay?.error !== undefined;
  const total = state.devices.reduce((sum, device) => sum + device.traffic.up + device.traffic.down, 0);
  return (
    <div className="phone-map" role="group" aria-label="远程访问链路图" data-motion={reduced ? "reduced" : "full"}>
      <svg viewBox="0 0 624 252" preserveAspectRatio="none" className="phone-lanes" aria-hidden="true">
        <path
          className={`phone-lane phone-trunk ${broken ? "broken" : live ? "" : "offline"}`}
          d={broken ? "M 95 112 H 157 M 179 112 H 245" : "M 95 112 H 245"}
        />
        {slots.map((slot) => (
          <g
            key={slot.id}
            data-device={slot.id}
            data-dim={hover !== null && hover !== slot.id}
            style={slot.device === null ? {} : deviceStyle(slot.id)}
          >
            <path
              className={`phone-lane ${slot.online ? "online" : "offline"}`}
              d={`M268 112 C352.5 112 352.5 ${slot.y} 437 ${slot.y}`}
            />
            <path
              className="phone-lane-hit"
              data-testid={`lane-${slot.id}`}
              d={`M268 112 C352.5 112 352.5 ${slot.y} 437 ${slot.y}`}
              onPointerEnter={() => onHover(slot.id)}
              onPointerLeave={() => onHover(null)}
              onClick={() => (slot.id === "more" ? onMore() : onSelect(slot.id))}
            />
            {slot.online && reduced ? (
              <g className="phone-static-arrows">
                <text x="330" y={112 + (slot.y - 112) * 0.3}>
                  ‹
                </text>
                <text x="387" y={112 + (slot.y - 112) * 0.8}>
                  ›
                </text>
              </g>
            ) : null}
            {slot.online && moving && frame.lane !== null ? (
              <Packet
                {...lanePoint(slot.y, frame.lane)}
                fraction={frame.lane}
                color="var(--device-color, var(--text-muted))"
              />
            ) : null}
          </g>
        ))}
        {moving && frame.trunk !== null ? (
          <Packet x={72 + 196 * frame.trunk} y={112} fraction={frame.trunk} color="var(--tint)" />
        ) : null}
        {live && reduced ? (
          <g className="phone-static-arrows">
            <text x="137" y="112">
              ‹
            </text>
            <text x="203" y="112">
              ›
            </text>
          </g>
        ) : null}
      </svg>
      <button
        type="button"
        className="phone-map-node"
        style={{ left: "11.54%" }}
        aria-pressed={selected === "mac"}
        onClick={() => onSelect("mac")}
      >
        <span
          className={`phone-map-tile ${moving && elapsed % 3900 >= 1270 && elapsed % 3900 < 1450 ? "arrived" : ""}`}
        >
          <Laptop size={22} />
        </span>
        <span>这台 Mac</span>
        <small>{state.enabled ? remoteRate(live ? total : 0) : "远程访问已关闭"}</small>
      </button>
      <button
        type="button"
        className="phone-map-node"
        style={{ left: "42.95%" }}
        aria-pressed={selected === "relay"}
        onClick={() => onSelect("relay")}
      >
        <span className="phone-map-tile">
          <Cloud size={22} />
          <span data-testid="relay-lock" className="phone-lock" data-lit={moving && frame.lock}>
            <Lock size={10} />
          </span>
        </span>
        <span>relay</span>
        <small>{live ? remoteRate(total) : state.relay?.status === "connecting" ? "正在连接" : "未连接"}</small>
      </button>
      {slots.map((slot) => (
        <button
          key={slot.id}
          type="button"
          className={`phone-map-phone ${slot.online ? "" : "offline"}`}
          style={{ ...deviceStyle(slot.id), left: "72.44%", top: slot.y }}
          data-device={slot.id}
          data-dim={hover !== null && hover !== slot.id}
          aria-pressed={selected === slot.id}
          onPointerEnter={() => onHover(slot.id)}
          onPointerLeave={() => onHover(null)}
          onFocus={() => onHover(slot.id)}
          onBlur={() => onHover(null)}
          onClick={() => (slot.id === "more" ? onMore() : onSelect(slot.id))}
        >
          <span
            className={`phone-device-tile ${slot.online && moving && elapsed % 3900 >= 2870 && elapsed % 3900 < 3100 ? "arrived" : ""}`}
          >
            {slot.id === "more" ? `+${hidden.length}` : <Phone size={15} />}
          </span>
          <span>
            <b>{slot.name}</b>
            <small>{slot.sub}</small>
          </span>
        </button>
      ))}
      <span className={`phone-map-note ${broken ? "error" : ""}`}>
        {broken
          ? "连不上 relay"
          : live
            ? "只转发 · 看不到内容"
            : !state.enabled
              ? "远程访问已关闭"
              : state.relay === null
                ? "还没接 relay"
                : "正在连接"}
      </span>
      {broken ? (
        <span className="phone-map-break">
          <WarningCircle size={14} />
        </span>
      ) : null}
      <div className="phone-map-legend">
        {reduced ? (
          <span>箭头表示两个方向（减弱动态效果）</span>
        ) : (
          <>
            <span data-active={moving && frame.direction === "up"}>↑ 上行 · 手机 → Mac</span>
            <span data-active={moving && frame.direction === "down"}>↓ 下行 · Mac → 手机</span>
          </>
        )}
        <span>
          <Lock size={11} />
          保持加密
        </span>
      </div>
    </div>
  );
}

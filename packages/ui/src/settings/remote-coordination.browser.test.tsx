import type { RemoteState, RemoteRelayDiagnostics } from "@atrium/protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ClockContext } from "../state/clock";
import { remoteTestClock } from "../test/remote-clock";
import { fakeClient } from "../test/fake-client";
import { PhoneSection } from "./phone-section";
import { SettingsPanel } from "./settings-panel";
import "../styles.css";

/** A finished connection check, including a deliberately mixed set of real observations. */
const CHECK: RemoteRelayDiagnostics = {
  kind: "connect",
  checkedAt: 1792994400000,
  network: "passed",
  resolution: "not_applicable",
  tls: "failed",
  token: "unknown",
  failure: "tls_failed",
};
/** A synthetic fixture with a valid, unauthenticated candidate. */
const PAIR = {
  pairingId: "pair_0123456789abcdef",
  qr: "atrium://pair?v=1&psk=synthetic",
  expiresAt: 300000,
  state: "available" as const,
  handshaking: true,
  reason: null,
  request: null,
  refused: 0,
};
/** Protocol 27 data; device name deliberately differs from the reported model. */
const STATE: RemoteState = {
  enabled: true,
  vault: "ok",
  hostFingerprint: null,
  relay: {
    url: "wss://relay.example.com",
    hostId: "hst_0123456789abcdef",
    status: "connected",
    error: null,
    lastConnectedAt: 1,
    diagnostics: CHECK,
  },
  devices: [
    {
      deviceId: "dev_0123456789abcdef",
      name: "My iPhone",
      model: "iPhone 16 Pro",
      pairedAt: 1,
      lastSeenAt: 1,
      online: false,
      traffic: { up: 0, down: 0 },
    },
  ],
  pairing: null,
};

it("shows self-reported model and never infers it from a device name", async () => {
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: "查看 My iPhone" }).click();
  await expect.element(screen.getByText("iPhone 16 Pro", { exact: true })).toBeVisible();
  fake.remote.setState({ state: { ...STATE, devices: STATE.devices.map((device) => ({ ...device, model: null })) } });
  await expect.element(screen.getByText("宿主未提供", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("iPhone 16 Pro", { exact: true })).not.toBeInTheDocument();
});

it("renders only diagnostic evidence, retaining its timestamp through retry and clearing on null", async () => {
  const gate = Promise.withResolvers<void>();
  const fake = fakeClient({}, { remote: STATE, remoteCommand: () => gate.promise });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByRole("region", { name: "诊断清单" })).toBeVisible();
  expect(
    [...screen.container.querySelectorAll(".phone-diagnostics small")].map((node) => node.textContent),
  ).toStrictEqual(["已通过", "不适用", "未通过", "未知"]);
  await expect.element(screen.getByText("到 relay 的 TCP 连接", { exact: true })).toBeVisible();
  expect(screen.container.querySelector(".phone-diagnostics time")?.getAttribute("dateTime")).toBe(
    new Date(CHECK.checkedAt).toISOString(),
  );
  await screen.getByRole("button", { name: "测试连接", exact: true }).click();
  fake.remote.setState({ state: { ...STATE, relay: { ...STATE.relay!, status: "connecting" } } });
  expect(screen.container.querySelector(".phone-diagnostics time")?.getAttribute("dateTime")).toBe(
    new Date(CHECK.checkedAt).toISOString(),
  );
  await expect
    .element(screen.getByText("TLS 连接失败，请检查 relay 的证书和反向代理。", { exact: true }))
    .toBeVisible();
  gate.resolve();
  fake.remote.setState({ state: { ...STATE, relay: { ...STATE.relay!, diagnostics: null } } });
  await expect.element(screen.getByText("尚无已完成的检查", { exact: true })).toBeVisible();
  expect(screen.container.querySelector(".phone-diagnostics time")).toBeNull();
});

it("labels live checks as liveness rather than reauthentication and gives no broader availability promise", async () => {
  const diagnostics: RemoteRelayDiagnostics = {
    kind: "live",
    checkedAt: CHECK.checkedAt + 1000,
    network: "passed",
    resolution: "unknown",
    tls: "not_applicable",
    token: "unknown",
    failure: null,
  };
  const fake = fakeClient({}, { remote: { ...STATE, relay: { ...STATE.relay!, diagnostics } } });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByText("当前控制连接活性检查", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("本次未重新解析地址、建立 TLS 或认证令牌；未知不表示失败。", { exact: true }))
    .toBeVisible();
  expect(
    [...screen.container.querySelectorAll(".phone-diagnostics small")].map((node) => node.textContent),
  ).toStrictEqual(["已通过", "未知", "不适用", "未知"]);
  await screen.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("relay 控制链路检查通过，不代表手机或 pi 可用");
  expect(screen.container.textContent).not.toContain("令牌也对");
  expect(screen.container.textContent).not.toContain("可能暂时重连现有连接");
});

it.each([
  ["resolution_failed", "解析 relay 地址失败，请检查域名。"],
  ["tcp_connect_failed", "无法建立到 relay 的 TCP 连接，请检查地址、端口和网络路径。"],
  ["tls_failed", "TLS 连接失败，请检查 relay 的证书和反向代理。"],
  ["websocket_upgrade_failed", "WebSocket 升级失败，请检查反向代理的升级配置。"],
  ["token_rejected", "relay 拒绝了宿主令牌，请重新粘贴 add-host 或 rotate-host 打印的行。"],
  ["timeout", "本次检查超时，未观察到的步骤仍为未知。"],
  ["connection_closed", "检查期间连接关闭，请重试；不能据此判断哪一步失败。"],
  ["unknown", "检查未完成，宿主没有更细的失败证据。"],
] as const)("uses safe wording and repair controls for %s", async (failure, words) => {
  const fake = fakeClient({}, { remote: { ...STATE, relay: { ...STATE.relay!, diagnostics: { ...CHECK, failure } } } });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByText(words, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "现在重试" }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "testRelay"]);
});

it("shows anonymous handshaking for exactly its active lifetime, clearing packets on false, replacement and expiry", async () => {
  await page.viewport(1280, 820);
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: { ...STATE, pairing: PAIR } });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).toBeVisible();
  clock.advance(320);
  await expect
    .poll(() => screen.container.querySelectorAll('[data-testid="handshake-packets"] .phone-packet').length)
    .toBe(1);
  expect(screen.container.querySelector('[data-testid="handshake-packets"] .phone-packet')?.getAttribute("fill")).toBe(
    "var(--text-muted)",
  );
  clock.advance(4000);
  await expect
    .poll(() => screen.container.querySelectorAll('[data-testid="handshake-packets"] .phone-packet').length)
    .toBe(0);
  expect(clock.count()).toBe(2);
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, handshaking: false } } });
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).not.toBeInTheDocument();
  expect(clock.count()).toBe(1);
  // A true/false pair before the next animation tick must not queue a minimum-duration animation.
  fake.remote.setState({ state: { ...STATE, pairing: PAIR } });
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, handshaking: false } } });
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
  expect(clock.count()).toBe(1);
  fake.remote.setState({ state: { ...STATE, pairing: PAIR } });
  clock.advance(320);
  fake.remote.setState({
    state: { ...STATE, pairing: { ...PAIR, pairingId: "pair_0000000000000001", handshaking: false } },
  });
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, state: "expired", handshaking: true } } });
  await expect.element(screen.getByRole("heading", { name: "二维码已过期" })).toBeVisible();
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
  expect(clock.count()).toBe(0);
  await screen.unmount();
  expect(clock.count()).toBe(0);
});

it("restarts a handshake round only for a new pairing identity, and clears it on cancellation", async () => {
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: { ...STATE, pairing: PAIR } });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).toBeVisible();
  clock.advance(320);
  await expect
    .poll(() =>
      screen.getByTestId("handshake-packets").element().querySelector(".phone-packet")?.getAttribute("transform"),
    )
    .toBe("translate(352.5 123.5)");
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, pairingId: "pair_0000000000000001" } } });
  await expect
    .poll(() =>
      screen.getByTestId("handshake-packets").element().querySelector(".phone-packet")?.getAttribute("transform"),
    )
    .toBe("translate(437 135)");
  fake.remote.setState({ state: { ...STATE, pairing: null } });
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
  expect(clock.count()).toBe(0);
});

it.each(["expired", "rejected", "committed", "awaiting_confirmation"] as const)(
  "ignores obsolete handshake activity in state %s",
  async (state) => {
    const clock = remoteTestClock();
    const fake = fakeClient(
      {},
      {
        remote: {
          ...STATE,
          pairing: { ...PAIR, state, request: { deviceName: "Verified phone", model: "iPhone", sas: "123456" } },
        },
      },
    );
    const screen = await render(
      <ClockContext value={clock.clock}>
        <PhoneSection client={fake.client} />
      </ClockContext>,
    );
    await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).toBeVisible();
    await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).not.toBeInTheDocument();
    expect(clock.count()).toBe(0);
  },
);

it("does not reveal unauthenticated request data and stops at the original QR deadline", async () => {
  const clock = remoteTestClock();
  const fake = fakeClient(
    {},
    {
      remote: {
        ...STATE,
        pairing: { ...PAIR, request: { deviceName: "untrusted candidate", model: "not verified", sas: "123456" } },
      },
    },
  );
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("untrusted candidate");
  expect(screen.container.textContent).not.toContain("not verified");
  clock.advance(300000);
  await expect.element(screen.getByRole("heading", { name: "二维码已过期" })).toBeVisible();
  await expect.element(screen.getByTestId("handshake-packets")).not.toBeInTheDocument();
});

it("uses static handshake arrows without a frame timer under reduced motion", async () => {
  const native = window.matchMedia.bind(window);
  const media = vi.spyOn(window, "matchMedia").mockImplementation(() => native("all"));
  onTestFinished(() => media.mockRestore());
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: { ...STATE, pairing: PAIR } });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByTestId("handshake-arrows")).toBeInTheDocument();
  expect(screen.container.querySelectorAll(".phone-packet").length).toBe(0);
  // Only the QR countdown and its fixed expiry deadline remain; no animation frame timer.
  expect(clock.count()).toBe(2);
  fake.remote.setState({ state: { ...STATE, pairing: null } });
  await expect.element(screen.getByTestId("handshake-arrows")).not.toBeInTheDocument();
  expect(clock.count()).toBe(0);
});

it("captures protocol 27 diagnostic evidence and anonymous handshaking in both appearances", async () => {
  await page.viewport(1280, 820);
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: STATE });
  const wasDark = document.documentElement.classList.contains("dark");
  onTestFinished(() => {
    document.documentElement.classList.toggle("dark", wasDark);
  });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <SettingsPanel
        client={fake.client}
        section="phone"
        onSection={() => undefined}
        onClose={() => undefined}
        openUrl={() => undefined}
        reveal={undefined}
      />
    </ClockContext>,
  );
  for (const theme of ["light", "dark"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await expect.element(screen.getByText("到 relay 的 TCP 连接", { exact: true })).toBeVisible();
    await screen
      .getByRole("dialog", { name: "设置", exact: true })
      .screenshot({ path: `.vitest/phone-diagnostics-${theme}.png` });
  }
  fake.remote.setState({ state: { ...STATE, pairing: PAIR } });
  await expect.element(screen.getByRole("heading", { name: "等手机确认密钥" })).toBeVisible();
  clock.advance(320);
  for (const theme of ["light", "dark"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await screen
      .getByRole("dialog", { name: "设置", exact: true })
      .screenshot({ path: `.vitest/phone-handshake-${theme}.png` });
  }
  expect(screen.container.textContent).not.toContain("untrusted candidate");
});

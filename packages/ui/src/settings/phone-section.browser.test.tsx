import { expect, it, onTestFinished, vi } from "vitest";
import { ClockContext } from "../state/clock";
import { remoteTestClock } from "../test/remote-clock";
import { SettingsPanel } from "./settings-panel";
import { useState } from "react";
import { encode } from "uqr";
import type { SettingsSection } from "./settings-panel";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { RemoteState } from "@atrium/protocol";
import { CommandError } from "@atrium/client";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { PhoneSection } from "./phone-section";

/** A connected host with a real-shaped phone and no secrets. */
const STATE: RemoteState = {
  enabled: true,
  vault: "ok",
  relay: {
    url: "wss://relay.example.com/atrium",
    hostId: "hst_0123456789abcdef",
    status: "connected",
    error: null,
    lastConnectedAt: 1,
    diagnostics: null,
  },
  hostFingerprint: "7f3a9c21e04b55d8",
  devices: [
    {
      deviceId: "dev_0123456789abcdef",
      name: "工作 iPhone",
      model: null,
      pairedAt: 1,
      lastSeenAt: 2,
      online: true,
      traffic: { down: 12288, up: 0 },
    },
  ],
  pairing: null,
};

it("watches only while mounted, links hover and sends rename and revoke after confirmation", async () => {
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  await screen.getByTestId("device-dev_0123456789abcdef").hover();
  expect(screen.getByTestId("lane-dev_0123456789abcdef").element().parentElement?.getAttribute("data-dim")).toBe(
    "false",
  );
  await screen.getByRole("button", { name: "改名 工作 iPhone" }).click();
  await screen.getByRole("textbox", { name: "设备名字" }).fill("我的手机");
  await userEvent.keyboard("{Enter}");
  await screen.getByRole("button", { name: "撤销 工作 iPhone" }).click();
  await expect.element(screen.getByText(/撤销后.*再用要重新扫码配对/)).toBeVisible();
  await screen.getByRole("button", { name: "确认撤销" }).click();
  await screen.unmount();
  expect(fake.calls).toStrictEqual([
    "watchRemote true",
    "renameDevice dev_0123456789abcdef 我的手机",
    "revokeDevice dev_0123456789abcdef",
    "watchRemote false",
  ]);
});

it("keeps failed actions visible and retryable without printing host error text", async () => {
  const fake = fakeClient(
    {},
    { remote: STATE, remoteCommand: () => Promise.reject(new CommandError("relay_rejected")) },
  );
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("relay 不认可宿主令牌，请粘贴 add-host 或 rotate-host 打印的新行。重试操作");
  await screen.getByRole("button", { name: "重试操作" }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "testRelay", "testRelay"]);
});

it.each([
  ["waiting", "等待钥匙串授权，请在 macOS 弹窗中允许 Atrium"],
  ["keychain_unavailable", "钥匙串不可用，请允许 Atrium 访问钥匙串后重试"],
  ["corrupt", "保险箱损坏，需要重置宿主身份；所有手机都要重新配对"],
  ["unavailable", "宿主未在 Electron 中运行，远程访问不可用"],
] as const)("renders vault %s without inventing a connected relay", async (vault, words) => {
  const fake = fakeClient({}, { remote: { ...STATE, vault } });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByText(words, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "配对新设备" })).toBeDisabled();
});

it("shows the first-use switch and requires inline confirmation to reset a corrupt vault", async () => {
  const fake = fakeClient();
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("switch", { name: "允许手机远程访问" }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "setRemote true"]);
  fake.remote.setState({ state: { ...STATE, vault: "corrupt" } });
  await screen.getByRole("button", { name: "重置", exact: true }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "setRemote true"]);
  await screen.getByRole("button", { name: "撤销全部并重新生成", exact: true }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "setRemote true", "resetRemoteIdentity"]);
});

it.each(["relay_unreachable", "relay_rejected"] as const)(
  "shows an honest diagnostic checklist for %s",
  async (error) => {
    const fake = fakeClient({}, { remote: { ...STATE, relay: { ...STATE.relay!, status: "error", error } } });
    const screen = await render(<PhoneSection client={fake.client} />);
    await expect.element(screen.getByText("诊断", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("尚无已完成的检查", { exact: true })).toBeVisible();
    expect(screen.container.querySelectorAll(".phone-diagnostics small").length).toBe(0);
    await screen.getByRole("button", { name: "重新粘贴" }).click();
    await expect.element(screen.getByText(/换了 relay 地址或宿主 id/)).toBeVisible();
  },
);

it("does not claim TLS was verified for the protocol's local ws test relay", async () => {
  const fake = fakeClient(
    {},
    {
      remote: {
        ...STATE,
        relay: {
          ...STATE.relay!,
          url: "ws://localhost:8787",
          status: "error",
          error: "relay_rejected",
          diagnostics: {
            kind: "connect",
            checkedAt: 1,
            network: "passed",
            resolution: "unknown",
            tls: "not_applicable",
            token: "failed",
            failure: "token_rejected",
          },
        },
      },
    },
  );
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByText("不适用", { exact: true })).toBeVisible();
  expect(screen.container.querySelector('[data-check="tls"]')?.getAttribute("data-result")).toBe("not_applicable");
});

it("saves relay credentials without echoing them and restores names on empty input", async () => {
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: "替换", exact: true }).click();
  const input = screen.getByLabelText("relay 的那一行");
  await input.fill(`atrium-relay://hst_0123456789abcdef:${"a".repeat(43)}@relay.example.com`);
  await screen.getByRole("button", { name: "保存并连接" }).click();
  await expect.element(input).not.toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("a".repeat(43));
  await screen.getByRole("button", { name: "改名 工作 iPhone" }).click();
  await screen.getByRole("textbox", { name: "设备名字" }).fill("");
  await userEvent.keyboard("{Enter}");
  expect(fake.calls).toStrictEqual([
    "watchRemote true",
    "setRemote true [redacted]",
    "renameDevice dev_0123456789abcdef ",
  ]);
});

it("keeps revoke retry even after the host hides the device on a vault write failure", async () => {
  const fake = fakeClient(
    {},
    { remote: STATE, remoteCommand: () => Promise.reject(new CommandError("keychain_unavailable")) },
  );
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: "撤销 工作 iPhone" }).click();
  await screen.getByRole("button", { name: "确认撤销" }).click();
  fake.remote.setState({ state: { ...STATE, devices: [] } });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("没能写入保险箱，重启 Atrium 后它会恢复。请重试。重试操作");
  await screen.getByRole("button", { name: "重试操作" }).click();
  expect(fake.calls).toStrictEqual([
    "watchRemote true",
    "revokeDevice dev_0123456789abcdef",
    "revokeDevice dev_0123456789abcdef",
  ]);
});

/** A synthetic one-time URI, never a real credential. */
const PAIR = {
  pairingId: "pair_0123456789abcdef",
  qr: "atrium://pair?v=1&psk=synthetic-test-secret",
  expiresAt: 300000,
  state: "available" as const,
  handshaking: false,
  reason: null,
  request: null,
  refused: 0,
};

it("counts down a real QR, refreshes expiry, confirms only the host pairing id and shows completion", async () => {
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: { ...STATE, pairing: PAIR } });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByRole("img", { name: "一次性配对二维码" })).toBeVisible();
  await expect.element(screen.getByRole("timer")).toHaveTextContent("5:00 后过期");
  const matrix = encode(PAIR.qr, { ecc: "M", border: 4 });
  expect(screen.getByRole("img", { name: "一次性配对二维码" }).element().querySelector("path")?.getAttribute("d")).toBe(
    matrix.data
      .flatMap((row, y) =>
        row
          .map((dark, x) => ({ dark, x }))
          .filter((cell) => cell.dark)
          .map((cell) => `M${cell.x} ${y}h1v1h-1z`),
      )
      .join(""),
  );
  clock.advance(300000);
  await expect.element(screen.getByText("二维码已过期", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "一次性配对二维码" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "刷新二维码" }).click();
  fake.remote.setState({
    state: {
      ...STATE,
      pairing: {
        ...PAIR,
        state: "awaiting_confirmation",
        refused: 2,
        request: { deviceName: "小林的 iPhone", model: "iPhone 16", sas: "482916" },
      },
    },
  });
  await expect.element(screen.getByText("小林的 iPhone 请求配对")).toBeVisible();
  await expect.element(screen.getByText("另一台手机也扫了这个码，已拒绝（2 次）")).toBeVisible();
  expect(screen.getByLabelText("校验码 482 916").element().textContent).toBe("482916");
  await screen.getByRole("button", { name: "确认配对" }).click();
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, state: "committed" } } });
  await expect.element(screen.getByText("配对成功，手机已加入设备列表。")).toBeVisible();
  await screen.getByRole("button", { name: "完成", exact: true }).click();
  expect(fake.calls).toStrictEqual([
    "watchRemote true",
    "startPairing",
    "confirmPairing pair_0123456789abcdef true",
    "cancelPairing",
  ]);
  expect(screen.container.innerHTML).not.toContain(PAIR.qr);
});

it("declines a pairing and Escape cancels the sheet rather than closing settings", async () => {
  const fake = fakeClient(
    {},
    {
      remote: {
        ...STATE,
        pairing: {
          ...PAIR,
          state: "awaiting_confirmation",
          request: { deviceName: "iPhone", model: "iPhone 16", sas: "000001" },
        },
      },
    },
  );
  const closed: boolean[] = [];
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="phone"
      onSection={() => undefined}
      onClose={() => closed.push(true)}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  await screen.getByRole("button", { name: "拒绝", exact: true }).click();
  fake.remote.setState({ state: { ...STATE, pairing: { ...PAIR, state: "rejected", reason: "declined" } } });
  await expect.element(screen.getByText("你已拒绝这台手机")).toBeVisible();
  await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(fake.calls).toStrictEqual(["watchRemote true", "confirmPairing pair_0123456789abcdef false", "cancelPairing"]);
  expect(closed).toStrictEqual([]);
});

it("animates the lock on a fake clock and frees timers, subscriptions and DOM across repeated page opens", async () => {
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: STATE });
  for (let index = 0; index < 12; index += 1) {
    const screen = await render(
      <ClockContext value={clock.clock}>
        <PhoneSection client={fake.client} />
      </ClockContext>,
    );
    await expect.element(screen.getByTestId("relay-lock")).toHaveAttribute("data-lit", "false");
    expect(clock.count()).toBe(1);
    clock.advance(700);
    await expect.element(screen.getByTestId("relay-lock")).toHaveAttribute("data-lit", "true");
    clock.advance(700);
    await expect.element(screen.getByTestId("relay-lock")).toHaveAttribute("data-lit", "false");
    await screen.unmount();
    expect(clock.count()).toBe(0);
    expect(document.querySelectorAll(".phone-settings,.phone-pair-sheet").length).toBe(0);
    expect(fake.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  }
  expect(fake.calls).toStrictEqual(Array.from({ length: 12 }).flatMap(() => ["watchRemote true", "watchRemote false"]));
});

/**
 * Forces only the reduced-motion query while retaining real media listeners.
 * @remarks Browser emulation is not exposed by Vitest; the native all-query supplies the actual interface.
 * @sideEffects Temporarily replaces matchMedia until the test restores it.
 * @returns The restorable spy.
 */
function forceReducedMotion() {
  const native = window.matchMedia.bind(window);
  return vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => native(query === "(prefers-reduced-motion: reduce)" ? "all" : query));
}

it("releases pairing countdowns and Escape listeners on every unmount", async () => {
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: { ...STATE, pairing: PAIR } });
  for (let index = 0; index < 8; index += 1) {
    const screen = await render(
      <ClockContext value={clock.clock}>
        <PhoneSection client={fake.client} />
      </ClockContext>,
    );
    await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).toBeVisible();
    expect(clock.count()).toBe(2);
    await screen.unmount();
    expect(clock.count()).toBe(0);
    await userEvent.keyboard("{Escape}");
  }
  expect(fake.calls).toStrictEqual(Array.from({ length: 8 }).flatMap(() => ["watchRemote true", "watchRemote false"]));
});

it("replaces motion with static arrows and draws only four phones plus a collapsed source", async () => {
  const media = forceReducedMotion();
  onTestFinished(() => media.mockRestore());
  const clock = remoteTestClock();
  const devices = Array.from({ length: 6 }, (_, index) => ({
    ...STATE.devices[0]!,
    deviceId: `dev_${String(index).padStart(16, "0")}`,
    name: `Phone ${index}`,
  }));
  const fake = fakeClient({}, { remote: { ...STATE, devices } });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toHaveAttribute("data-motion", "reduced");
  expect(clock.count()).toBe(0);
  expect(screen.container.querySelectorAll(".phone-packet").length).toBe(0);
  expect(screen.container.querySelectorAll(".phone-static-arrows").length).toBe(6);
  expect(screen.container.querySelectorAll(".phone-map-phone").length).toBe(5);
  expect(screen.container.querySelectorAll(".phone-device-row").length).toBe(6);
  await screen.getByRole("button", { name: /还有 2 台/ }).click();
  await screen.getByTestId("device-dev_0000000000000000").hover();
  expect(screen.container.querySelectorAll('[data-device="dev_0000000000000001"][data-dim="true"]').length).toBe(3);
  await screen
    .getByRole("group", { name: "远程访问链路图" })
    .getByRole("button", { name: /^Phone 1/ })
    .hover();
  await expect.element(screen.getByTestId("device-dev_0000000000000000")).toHaveAttribute("data-dim", "true");
  await expect.element(screen.getByTestId("device-dev_0000000000000001")).toHaveAttribute("data-dim", "false");
  await screen.getByTestId("lane-dev_0000000000000000").hover();
  await expect.element(screen.getByTestId("device-dev_0000000000000000")).toHaveAttribute("data-dim", "false");
});

/** Navigates the actual settings categories. @remarks Tests page lifetime rather than component lifetime alone. @sideEffects Updates local section state. @param props - The fake client. @returns Settings panel. */
function SettingsHarness({ client }: { readonly client: ReturnType<typeof fakeClient>["client"] }) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <SettingsPanel
      client={client}
      section={section}
      onSection={setSection}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />
  );
}

it("starts and stops watching with settings category navigation", async () => {
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(<SettingsHarness client={fake.client} />);
  expect(fake.calls).toStrictEqual([]);
  await screen.getByRole("button", { name: "手机", exact: true }).click();
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "watchRemote false"]);
});

it("reports failures for rename, reset, starting and confirming pairing without optimistic access", async () => {
  const fake = fakeClient(
    {},
    { remote: STATE, remoteCommand: () => Promise.reject(new CommandError("keychain_unavailable")) },
  );
  const screen = await render(<PhoneSection client={fake.client} />);
  await screen.getByRole("button", { name: "改名 工作 iPhone" }).click();
  await screen.getByRole("textbox", { name: "设备名字" }).fill("未保存");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("钥匙串不可用，请允许 Atrium 访问钥匙串后重试。重试操作");
  expect(fake.remote.getState().state?.devices[0]?.name).toBe("工作 iPhone");
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("button", { name: "撤销全部…" }).click();
  await screen.getByRole("button", { name: "撤销全部并重新生成", exact: true }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("钥匙串不可用，请允许 Atrium 访问钥匙串后重试。重试操作");
  expect(fake.remote.getState().state?.devices).toStrictEqual(STATE.devices);
  await screen.getByRole("button", { name: "配对新设备", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).not.toBeInTheDocument();
  fake.remote.setState({
    state: {
      ...STATE,
      pairing: {
        ...PAIR,
        state: "awaiting_confirmation",
        request: { deviceName: "iPhone", model: "iPhone 16", sas: "123456" },
      },
    },
  });
  await screen.getByRole("button", { name: "确认配对" }).click();
  await expect
    .element(screen.getByRole("dialog", { name: "配对新设备" }).getByRole("alert"))
    .toHaveTextContent("钥匙串不可用，请允许 Atrium 访问钥匙串后重试。");
  expect(fake.calls).toStrictEqual([
    "watchRemote true",
    "renameDevice dev_0123456789abcdef 未保存",
    "resetRemoteIdentity",
    "startPairing",
    "confirmPairing pair_0123456789abcdef true",
  ]);
});

it("shows failed reads and disables stale controls while the desktop connection is lost", async () => {
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(<PhoneSection client={fake.client} />);
  fake.remote.setState({ status: "failed", state: null, error: new CommandError("remote_unavailable") });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("远程访问暂不可用，请检查开关、relay 和钥匙串授权。重新读取");
  await screen.getByRole("button", { name: "重新读取" }).click();
  fake.connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
  await expect.element(screen.getByRole("button", { name: "配对新设备" })).toBeDisabled();
  await expect.element(screen.getByText("与宿主的连接已断开，以下是上次状态；重连后自动刷新。")).toBeVisible();
  expect(screen.container.querySelectorAll(".phone-packet").length).toBe(0);
  expect(fake.calls).toStrictEqual(["watchRemote true", "watchRemote true"]);
});

it.each([
  { reason: "cancelled" as const, text: "这次配对已取消" },
  { reason: "timeout" as const, text: "等待确认超时" },
  { reason: "disconnected" as const, text: "手机在确认前断开了" },
  { reason: "vault_failed" as const, text: "没能写入保险箱，请检查钥匙串后重新配对" },
])("shows pairing failure $reason and permits refreshing", async ({ reason, text }) => {
  const fake = fakeClient({}, { remote: { ...STATE, pairing: { ...PAIR, state: "rejected", reason } } });
  const screen = await render(<PhoneSection client={fake.client} />);
  await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "刷新二维码" }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "startPairing"]);
});

it("lets Escape dismiss a pairing while disconnected without pretending the host cancelled it", async () => {
  const fake = fakeClient(
    {},
    {
      remote: {
        ...STATE,
        pairing: {
          ...PAIR,
          state: "awaiting_confirmation",
          request: { deviceName: "iPhone", model: "iPhone 16", sas: "123456" },
        },
      },
    },
  );
  const screen = await render(<PhoneSection client={fake.client} />);
  fake.connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
  await expect.element(screen.getByRole("button", { name: "确认配对" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).not.toBeInTheDocument();
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
});

it("copies only the public fingerprint, resets feedback after two seconds and reports clipboard denial", async () => {
  // The browser clipboard is an external boundary; never change the user's clipboard in a test.
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  onTestFinished(() => copy.mockRestore());
  const clock = remoteTestClock();
  const fake = fakeClient({}, { remote: STATE });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <PhoneSection client={fake.client} />
    </ClockContext>,
  );
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("button", { name: "复制指纹", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "已复制指纹" })).toBeVisible();
  clock.advance(2000);
  await expect.element(screen.getByRole("button", { name: "复制指纹", exact: true })).toBeVisible();
  copy.mockRejectedValue(new Error("sensitive external detail"));
  await screen.getByRole("button", { name: "复制指纹", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("操作未完成，请重试。重试操作");
  expect(copy.mock.calls).toStrictEqual([["7F3A 9C21 E04B 55D8"], ["7F3A 9C21 E04B 55D8"]]);
  expect(screen.container.textContent).not.toContain("sensitive external detail");
});

it("blocks duplicate commands before a render disables controls", async () => {
  const gate = Promise.withResolvers<void>();
  const fake = fakeClient({}, { remote: STATE, remoteCommand: () => gate.promise });
  const screen = await render(<PhoneSection client={fake.client} />);
  const button = screen.getByRole("button", { name: "测试连接", exact: true }).element();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.element(screen.getByRole("button", { name: "正在处理…", exact: true })).toBeDisabled();
  expect(fake.calls).toStrictEqual(["watchRemote true", "testRelay"]);
  gate.resolve();
  await expect.element(screen.getByRole("status")).toHaveTextContent("relay 控制链路检查通过，不代表手机或 pi 可用");
});

it("captures light and dark real settings at the approved window size", async () => {
  await page.viewport(1280, 820);
  const fake = fakeClient(
    {},
    {
      remote: {
        ...STATE,
        devices: [
          STATE.devices[0]!,
          { ...STATE.devices[0]!, deviceId: "dev_0000000000000002", name: "iPad Air", traffic: { up: 0, down: 0 } },
          {
            ...STATE.devices[0]!,
            deviceId: "dev_0000000000000003",
            name: "旧 iPhone",
            online: false,
            traffic: { up: 0, down: 0 },
          },
        ],
      },
    },
  );
  const oldDark = document.documentElement.classList.contains("dark");
  onTestFinished(() => {
    document.documentElement.classList.toggle("dark", oldDark);
  });
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="phone"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  document.documentElement.classList.remove("dark");
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  await screen
    .getByRole("dialog", { name: "设置", exact: true })
    .screenshot({ path: ".vitest/phone-settings-light.png" });
  document.documentElement.classList.add("dark");
  await screen
    .getByRole("dialog", { name: "设置", exact: true })
    .screenshot({ path: ".vitest/phone-settings-dark.png" });
  expect(screen.getByRole("dialog", { name: "设置", exact: true }).element().getBoundingClientRect().width).toBe(900);
});

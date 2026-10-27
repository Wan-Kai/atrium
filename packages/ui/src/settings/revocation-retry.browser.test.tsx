import { createAtriumClient, type AtriumClient } from "@atrium/client";
import {
  ClientMessage,
  PROTOCOL_VERSION,
  type Command,
  type ErrorCode,
  type HostMessage,
  type RemoteDevice,
  type RemoteState,
} from "@atrium/protocol";
import { useState } from "react";
import { expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ClockContext } from "../state/clock";
import { remoteTestClock } from "../test/remote-clock";
import { SettingsPanel, type SettingsSection } from "./settings-panel";
import "../styles.css";

/** Paired fixtures, not real device identities or credentials. */
const A: RemoteDevice = {
  deviceId: "dev_0000000000000001",
  name: "Phone A",
  model: null,
  online: false,
  pairedAt: 1,
  lastSeenAt: 1,
  traffic: { up: 0, down: 0 },
};
const B: RemoteDevice = { ...A, deviceId: "dev_0000000000000002", name: "Phone B" };
const READY: RemoteState = {
  enabled: true,
  vault: "ok",
  hostFingerprint: "0123456789abcdef",
  relay: {
    url: "wss://relay.example.com",
    hostId: "hst_0123456789abcdef",
    status: "connected",
    error: null,
    lastConnectedAt: 1,
    diagnostics: null,
  },
  devices: [A, B],
  pairing: null,
};

/**
 * Opens and closes the production settings owner.
 * @remarks No retry or watch state is implemented in this harness.
 * @sideEffects Changes visibility and selected category.
 * @param props - The actual client.
 * @returns A real settings window and its reopen button.
 */
function Window({ client }: { readonly client: AtriumClient }) {
  const [open, setOpen] = useState(true);
  const [section, setSection] = useState<SettingsSection>("phone");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开设置
      </button>
      {open ? (
        <SettingsPanel
          client={client}
          section={section}
          onSection={setSection}
          onClose={() => setOpen(false)}
          openUrl={() => undefined}
          reveal={undefined}
        />
      ) : null}
    </>
  );
}

/**
 * Scripts responses at the actual client's socket boundary.
 * @remarks Production serialization, protocol validation and store delivery are not mocked.
 * @sideEffects Records commands and delivers scripted host frames.
 * @returns A socket plus host controls.
 */
function scriptedHost() {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const sent: Command[] = [];
  const host = {
    readyState: 1,
    send(data: string) {
      const message = ClientMessage.parse(JSON.parse(data));
      if (message.type !== "hello") sent.push(message);
    },
    close: () => undefined,
    addEventListener(type: string, listener: (event: never) => void) {
      (listeners[type] ??= []).push(listener);
    },
    receive(message: HostMessage) {
      listeners["message"]?.forEach((listener) => listener({ data: JSON.stringify(message) } as never));
    },
    open() {
      listeners["open"]?.forEach((listener) => listener(undefined as never));
      host.receive({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: "test",
        hostInstanceId: "h1",
        heartbeatMs: 15000,
        installSeed: 1,
        logDir: "/synthetic/logs",
      });
    },
    commands(type: Command["type"]) {
      return sent.filter((message) => message.type === type);
    },
    answer(type: Command["type"], result: unknown = {}, at = -1) {
      const command = host.commands(type).at(at);
      if (!command) throw new Error("No command to answer");
      host.receive({ type: "response", requestId: command.requestId, ok: true, result });
    },
    fail(type: Command["type"], code: ErrorCode, at = -1) {
      const command = host.commands(type).at(at);
      if (!command) throw new Error("No command to fail");
      host.receive({ type: "response", requestId: command.requestId, ok: false, error: { code } });
    },
    push(remote: RemoteState) {
      host.receive({ type: "remote_updated", remote });
    },
    revokedIds: () => sent.filter((command) => command.type === "revoke_device").map((command) => command.deviceId),
  };
  return host;
}

/**
 * Renders the real settings and client over a controlled host and clock.
 * @remarks The host can hide a blocked device before failing the vault write, as in production.
 * @sideEffects Connects the client, renders, and registers disconnect cleanup.
 * @returns The rendered settings, client and host.
 */
async function setup() {
  await page.viewport(1280, 820);
  const host = scriptedHost();
  const clock = remoteTestClock();
  const client = createAtriumClient({
    url: "ws://host.invalid",
    token: "synthetic",
    clientId: "revocation-test",
    openSocket: () => host,
    clock: { setTimeout: (run, ms) => clock.clock.after(ms, run) },
  });
  onTestFinished(() => client.disconnect());
  const connecting = client.connect();
  host.open();
  await connecting;
  const screen = await render(
    <ClockContext value={clock.clock}>
      <Window client={client} />
    </ClockContext>,
  );
  host.answer("get_remote", READY);
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  return { host, client, screen };
}

/**
 * Fails an explicit revoke after its device has vanished from the host's public list.
 * @remarks Tests never restore a blocked device to make retry reachable.
 * @sideEffects Clicks the production controls and delivers host events/responses.
 * @param fixture - The actual settings/client harness.
 * @param device - The paired device.
 * @param remaining - The host's list after blocking it.
 */
async function failRevoke(fixture: Awaited<ReturnType<typeof setup>>, device: RemoteDevice, remaining: RemoteDevice[]) {
  const { screen, host } = fixture;
  await screen.getByRole("button", { name: `撤销 ${device.name}`, exact: true }).click();
  await screen.getByRole("button", { name: "确认撤销", exact: true }).click();
  host.push({ ...READY, devices: remaining });
  host.fail("revoke_device", "keychain_unavailable");
  await expect.element(screen.getByText(/没能写入保险箱，重启 Atrium 后它会恢复/).first()).toBeVisible();
}

it("retains a hidden revoke target through unrelated success and failure and retries its exact id", async () => {
  const fixture = await setup();
  const { screen, host, client } = fixture;
  await failRevoke(fixture, A, [B]);
  await screen.getByRole("button", { name: "测试连接", exact: true }).click();
  host.answer("test_relay");
  await expect.element(screen.getByRole("status")).toHaveTextContent("relay 控制链路检查通过，不代表手机或 pi 可用");
  await screen.getByRole("button", { name: "改名 Phone B" }).click();
  await screen.getByRole("textbox", { name: "设备名字" }).fill("new name");
  await userEvent.keyboard("{Enter}");
  host.fail("rename_device", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "重试操作", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "重试撤销 Phone A", exact: true }).click();
  expect(host.revokedIds()).toStrictEqual([A.deviceId, A.deviceId]);
  host.answer("revoke_device");
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  expect(client.remote.getState().state?.devices).toStrictEqual([B]);
});

it("keeps multiple device targets across categories, clears only a successful retry, and forgets them on close", async () => {
  const fixture = await setup();
  const { screen, host } = fixture;
  await failRevoke(fixture, A, [B]);
  await failRevoke(fixture, B, []);
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  await screen.getByRole("button", { name: /^手机/ }).click();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "重试撤销 Phone A", exact: true }).click();
  host.answer("revoke_device");
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "关闭设置" }).click();
  await screen.getByRole("button", { name: "打开设置" }).click();
  host.answer("get_remote", { ...READY, devices: [] });
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).not.toBeInTheDocument();
  expect(host.revokedIds()).toStrictEqual([A.deviceId, B.deviceId, A.deviceId]);
});

it("clears old targets on identity or relay replacement and never revives them from late revoke failures", async () => {
  const fixture = await setup();
  const { screen, host } = fixture;
  await failRevoke(fixture, A, [B]);
  await screen.getByRole("button", { name: "重试撤销 Phone A", exact: true }).click();
  host.push({ ...READY, hostFingerprint: "1111111111111111", devices: [B] });
  host.fail("revoke_device", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "测试连接", exact: true })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "撤销 Phone B", exact: true }).click();
  await screen.getByRole("button", { name: "确认撤销", exact: true }).click();
  host.push({ ...READY, hostFingerprint: "1111111111111111", devices: [] });
  host.fail("revoke_device", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).toBeVisible();
  host.push({
    ...READY,
    hostFingerprint: "1111111111111111",
    relay: { ...READY.relay!, url: "wss://new-relay.example.com" },
    devices: [],
  });
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).not.toBeInTheDocument();
});

it("does not let old reset or closed-window callbacks alter newer retry targets", async () => {
  const fixture = await setup();
  const { screen, host } = fixture;
  await failRevoke(fixture, A, [B]);
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("button", { name: "撤销全部…" }).click();
  await screen.getByRole("button", { name: "撤销全部并重新生成", exact: true }).click();
  const replacement: RemoteState = { ...READY, hostFingerprint: "2222222222222222", devices: [B] };
  host.push(replacement);
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  await screen.getByRole("button", { name: /^手机/ }).click();
  await screen.getByRole("button", { name: "撤销 Phone B", exact: true }).click();
  await screen.getByRole("button", { name: "确认撤销", exact: true }).click();
  host.push({ ...replacement, devices: [] });
  host.fail("revoke_device", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).toBeVisible();
  host.answer("reset_remote_identity");
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  await screen.getByRole("button", { name: /^手机/ }).click();
  await screen.getByRole("button", { name: "重试撤销 Phone B", exact: true }).click();
  await screen.getByRole("button", { name: "关闭设置" }).click();
  await screen.getByRole("button", { name: "打开设置" }).click();
  host.answer("get_remote", { ...replacement, devices: [] });
  host.fail("revoke_device", "keychain_unavailable");
  await expect.element(screen.getByRole("group", { name: "远程访问链路图" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone B", exact: true })).not.toBeInTheDocument();
  expect(host.revokedIds()).toStrictEqual([A.deviceId, B.deviceId, B.deviceId]);
});

it("clears targets on successful reset even after leaving Phone, but not on failed reset", async () => {
  const fixture = await setup();
  const { screen, host } = fixture;
  await failRevoke(fixture, A, [B]);
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("button", { name: "撤销全部…" }).click();
  await screen.getByRole("button", { name: "撤销全部并重新生成", exact: true }).click();
  host.fail("reset_remote_identity", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "重试操作", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "重试操作", exact: true }).click();
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  host.answer("reset_remote_identity");
  await screen.getByRole("button", { name: /^手机/ }).click();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  expect(host.revokedIds()).toStrictEqual([A.deviceId]);
});

it("preserves hidden revoke targets after failed relay saves and successful same-identity token replacement", async () => {
  const fixture = await setup();
  const { screen, host, client } = fixture;
  await failRevoke(fixture, A, [B]);
  await screen.getByRole("button", { name: "替换", exact: true }).click();
  await screen
    .getByLabelText("relay 的那一行")
    .fill(`atrium-relay://hst_0123456789abcdef:${"a".repeat(43)}@relay.example.com`);
  await screen.getByRole("button", { name: "保存并连接" }).click();
  host.fail("set_remote", "keychain_unavailable");
  await expect.element(screen.getByRole("button", { name: "重试操作", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).toBeVisible();
  await screen
    .getByLabelText("relay 的那一行")
    .fill(`atrium-relay://hst_0123456789abcdef:${"b".repeat(43)}@relay.example.com`);
  await screen.getByRole("button", { name: "保存并连接" }).click();
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  host.push({ ...READY, devices: [B] });
  host.answer("set_remote");
  await screen.getByRole("button", { name: /^手机/ }).click();
  await screen.getByRole("button", { name: "重试撤销 Phone A", exact: true }).click();
  expect(host.revokedIds()).toStrictEqual([A.deviceId, A.deviceId]);
  host.answer("revoke_device");
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  expect(client.remote.getState().state?.devices).toStrictEqual([B]);
});

it.each([
  { field: "URL", relay: { ...READY.relay!, url: "wss://new-relay.example.com" } },
  { field: "hostId", relay: { ...READY.relay!, hostId: "hst_0000000000000001" } },
])("clears targets when the public relay $field actually changes", async ({ relay }) => {
  const fixture = await setup();
  const { screen, host } = fixture;
  await failRevoke(fixture, A, [B]);
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).toBeVisible();
  host.push({ ...READY, devices: [B], relay });
  await expect.element(screen.getByRole("button", { name: "重试撤销 Phone A", exact: true })).not.toBeInTheDocument();
  expect(host.revokedIds()).toStrictEqual([A.deviceId]);
});

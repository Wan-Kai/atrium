import { createAtriumClient, type AtriumClient } from "@atrium/client";
import { ClientMessage, PROTOCOL_VERSION, type HostMessage, type RemoteState } from "@atrium/protocol";
import { useState } from "react";
import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ClockContext } from "../state/clock";
import { remoteTestClock } from "../test/remote-clock";
import { fakeClient } from "../test/fake-client";
import { SettingsPanel, type SettingsSection } from "./settings-panel";
import "../styles.css";

/** Synthetic host state; the pairing key never comes from a user account. */
const READY: RemoteState = {
  enabled: true,
  vault: "ok",
  hostFingerprint: null,
  relay: {
    url: "wss://relay.example.com",
    hostId: "hst_0123456789abcdef",
    status: "connected",
    error: null,
    lastConnectedAt: 1,
    diagnostics: null,
  },
  devices: [],
  pairing: null,
};
/** A confirmation request received while another settings category is shown. */
const WAITING: RemoteState = {
  ...READY,
  pairing: {
    pairingId: "pair_0123456789abcdef",
    qr: "atrium://pair?psk=synthetic",
    expiresAt: 300000,
    state: "awaiting_confirmation",
    handshaking: false,
    reason: null,
    request: { deviceName: "Test phone", model: "iPhone", sas: "123456" },
    refused: 0,
  },
};

/**
 * Models a window opening and actually closing, while production SettingsPanel owns all watches.
 * @remarks The harness only navigates; it deliberately has no watch effect or store manipulation.
 * @sideEffects Changes the selected category and mounts/unmounts the real settings window.
 * @param props - Client and initial category.
 * @returns The window's entry button and, while open, SettingsPanel.
 */
function SettingsWindow({
  client,
  initial = "appearance",
}: {
  readonly client: AtriumClient;
  readonly initial?: SettingsSection;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>(initial);
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
 * Provides the real client's socket boundary without a network server.
 * @remarks Production request/response, schema validation and connection-generation guards remain real.
 * @sideEffects Records sent frames and delivers explicitly scripted socket events.
 * @returns The structural socket and host-side controls.
 */
function scriptedSocket() {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const sent: ClientMessage[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      sent.push(ClientMessage.parse(JSON.parse(data)));
    },
    close: () => undefined,
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    receive: (message: HostMessage) => {
      listeners["message"]?.forEach((listener) => listener({ data: JSON.stringify(message) } as never));
    },
    open: () => {
      listeners["open"]?.forEach((listener) => listener(undefined as never));
      socket.receive({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: "test",
        hostInstanceId: "h1",
        heartbeatMs: 15000,
        installSeed: 1,
        logDir: "/synthetic/logs",
      });
    },
    drop: () => {
      listeners["close"]?.forEach((listener) => listener({ code: 1006 } as never));
    },
    answerRemote: (remote: RemoteState, at = -1) => {
      const command = sent.filter((message) => message.type === "get_remote").at(at);
      if (command === undefined) throw new Error("No get_remote request to answer");
      socket.receive({ type: "response", requestId: command.requestId, ok: true, result: remote });
    },
    watches: () => sent.filter((message) => message.type === "get_remote").map((message) => message.watch),
    actions: () => sent.filter((message) => !["hello", "ping", "subscribe_index", "get_remote"].includes(message.type)),
  };
  return socket;
}

/**
 * Opens the production client against scripted sockets and a deterministic reconnect clock.
 * @remarks Only the transport and time are replaced; watches use the actual client store.
 * @sideEffects Connects the client and registers disconnect cleanup.
 * @returns The client, sockets and clock.
 */
async function connectedClient() {
  const clock = remoteTestClock();
  const sockets: ReturnType<typeof scriptedSocket>[] = [];
  const client = createAtriumClient({
    url: "ws://host.invalid",
    token: "synthetic",
    clientId: "settings-test",
    clock: { setTimeout: (run, ms) => clock.clock.after(ms, run) },
    openSocket: () => {
      const socket = scriptedSocket();
      sockets.push(socket);
      return socket;
    },
  });
  onTestFinished(() => client.disconnect());
  const ready = client.connect();
  sockets[0]!.open();
  await ready;
  return { client, clock, sockets };
}

it("watches for the whole real settings window and updates indicators across categories without granting access", async () => {
  await page.viewport(1280, 820);
  const { client, clock, sockets } = await connectedClient();
  const socket = sockets[0]!;
  const screen = await render(
    <ClockContext value={clock.clock}>
      <SettingsWindow client={client} />
    </ClockContext>,
  );
  expect(socket.watches()).toStrictEqual([]);
  await screen.getByRole("button", { name: "打开设置" }).click();
  await expect.poll(() => socket.watches()).toStrictEqual([true]);
  socket.answerRemote(WAITING);
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "外观", level: 2, exact: true })).toBeVisible();
  await screen
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: /^手机/ })
    .click();
  await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).toBeVisible();
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  expect(socket.watches()).toStrictEqual([true]);
  socket.receive({
    type: "remote_updated",
    remote: { ...READY, relay: { ...READY.relay!, status: "error", error: "relay_rejected" } },
  });
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).not.toBeInTheDocument();
  await expect.element(screen.getByLabelText("连不上 relay")).toBeVisible();
  socket.receive({ type: "remote_updated", remote: WAITING });
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).toBeVisible();
  socket.receive({
    type: "remote_updated",
    remote: { ...WAITING, pairing: { ...WAITING.pairing!, state: "committed" } },
  });
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).not.toBeInTheDocument();
  await expect.element(screen.getByLabelText("连不上 relay")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "关闭设置" }).click();
  expect(socket.watches()).toStrictEqual([true, false]);
  expect(client.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  socket.answerRemote(WAITING);
  socket.receive({ type: "remote_updated", remote: WAITING });
  expect(client.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  await screen.getByRole("button", { name: "打开设置" }).click();
  expect(socket.watches()).toStrictEqual([true, false, true]);
  socket.answerRemote(READY);
  await expect.poll(() => client.remote.getState().state).toStrictEqual(READY);
  await screen.getByRole("button", { name: "关闭设置" }).click();
  expect(socket.watches()).toStrictEqual([true, false, true, false]);
  expect(sockets).toHaveLength(1);
  expect(client.connection.getState().status).toBe("connected");
  expect(socket.actions()).toStrictEqual([]);
});

it("does not revive closed-window QR state from a late read and restores only an open window after reconnect", async () => {
  await page.viewport(1280, 820);
  const { client, clock, sockets } = await connectedClient();
  const socket = sockets[0]!;
  const screen = await render(<SettingsWindow client={client} />);
  await screen.getByRole("button", { name: "打开设置" }).click();
  await expect.poll(() => socket.watches()).toStrictEqual([true]);
  await screen.getByRole("button", { name: "关闭设置" }).click();
  socket.answerRemote(WAITING, 0);
  socket.receive({ type: "remote_updated", remote: WAITING });
  await expect.poll(() => client.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  socket.answerRemote(WAITING, 1);
  await screen.getByRole("button", { name: "打开设置" }).click();
  socket.answerRemote(READY);
  await expect.poll(() => client.remote.getState().state).toStrictEqual(READY);
  socket.drop();
  clock.advance(250);
  expect(sockets.length).toBe(2);
  const reconnected = sockets[1]!;
  reconnected.open();
  expect(reconnected.watches()).toStrictEqual([true]);
  reconnected.answerRemote(WAITING);
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).toBeVisible();
  await screen.getByRole("button", { name: "关闭设置" }).click();
  expect(reconnected.watches()).toStrictEqual([true, false]);
  socket.receive({ type: "remote_updated", remote: WAITING });
  reconnected.receive({ type: "remote_updated", remote: WAITING });
  expect(client.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  reconnected.drop();
  clock.advance(250);
  sockets[2]!.open();
  expect(sockets[2]!.watches()).toStrictEqual([]);
  expect([...socket.actions(), ...reconnected.actions(), ...sockets[2]!.actions()]).toStrictEqual([]);
});

it("releases Phone timers on category exit while keeping only the window's remote watch", async () => {
  await page.viewport(1280, 820);
  const clock = remoteTestClock();
  const active: RemoteState = {
    ...WAITING,
    pairing: { ...WAITING.pairing!, state: "available", request: null },
    devices: [
      {
        deviceId: "dev_0123456789abcdef",
        name: "Test phone",
        model: null,
        pairedAt: 1,
        lastSeenAt: 1,
        online: true,
        traffic: { up: 0, down: 0 },
      },
    ],
  };
  const fake = fakeClient({}, { remote: active });
  const screen = await render(
    <ClockContext value={clock.clock}>
      <SettingsWindow client={fake.client} initial="phone" />
    </ClockContext>,
  );
  await screen.getByRole("button", { name: "打开设置" }).click();
  await expect.element(screen.getByRole("img", { name: "一次性配对二维码" })).toBeVisible();
  expect(clock.count()).toBe(2);
  await screen.getByRole("button", { name: "关于", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "配对新设备" })).not.toBeInTheDocument();
  expect(clock.count()).toBe(0);
  expect(fake.remote.getState().state).toStrictEqual(active);
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
  fake.remote.setState({ state: WAITING });
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).toBeVisible();
  await screen.getByRole("button", { name: "关闭设置" }).click();
  expect(fake.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
  expect(clock.count()).toBe(0);
  expect(fake.calls).toStrictEqual(["watchRemote true", "watchRemote false"]);
});

it("keeps the watch while a dirty config intercepts closing and clears it only after actual dismissal", async () => {
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { remote: READY });
  const screen = await render(<SettingsWindow client={fake.client} initial="pi" />);
  await screen.getByRole("button", { name: "打开设置" }).click();
  await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
  await screen.getByRole("button", { name: "关闭设置" }).click();
  await expect.element(screen.getByText("有未保存的配置修改，放弃修改？")).toBeVisible();
  expect(fake.calls.filter((call) => call.startsWith("watchRemote"))).toStrictEqual(["watchRemote true"]);
  fake.remote.setState({ status: "ready", state: WAITING, error: null });
  await expect.element(screen.getByRole("img", { name: "等你确认配对" })).toBeVisible();
  await screen.getByRole("button", { name: "继续编辑" }).click();
  expect(fake.calls.filter((call) => call.startsWith("watchRemote"))).toStrictEqual(["watchRemote true"]);
  await screen.getByRole("button", { name: "关闭设置" }).click();
  await screen.getByRole("button", { name: "放弃修改" }).click();
  await expect.element(screen.getByRole("dialog", { name: "设置", exact: true })).not.toBeInTheDocument();
  expect(fake.calls.filter((call) => call.startsWith("watchRemote"))).toStrictEqual([
    "watchRemote true",
    "watchRemote false",
  ]);
  expect(fake.remote.getState()).toStrictEqual({ status: "idle", state: null, error: null });
});

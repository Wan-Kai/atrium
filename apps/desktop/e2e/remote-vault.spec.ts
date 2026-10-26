import { expect, test, type Page } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

let launched: LaunchedApp;
test.beforeEach(async () => {
  launched = await launchApp();
});
test.afterEach(async () => {
  await launched.close();
});

/**
 * Sends one local command through the real Electron host.
 * @remarks Protocol 26 is the MP3a frozen contract; no renderer access to vault IPC is introduced.
 * @sideEffects Opens and closes a local WebSocket.
 * @param page - The application's renderer.
 * @param command - Management command fields.
 * @returns The command response.
 */
async function request(page: Page, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return page.evaluate(async (value) => {
    const bootstrap = await window.atrium.getBootstrap();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = new WebSocket(bootstrap.hostUrl.replace(/^http/, "ws"));
      socket.addEventListener("error", () => reject(new Error("local socket failed")));
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 26,
            clientId: "remote-vault-e2e",
            token: bootstrap.token,
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          }),
        ),
      );
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "welcome")
          socket.send(
            JSON.stringify({
              ...value,
              requestId: "vault-check",
              traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
            }),
          );
        if (message.type === "response" && message.requestId === "vault-check") {
          socket.close();
          resolve(message);
        }
      });
    });
  }, command);
}

test("keeps remote storage unread and absent from the renderer bridge on startup", async () => {
  expect(await request(launched.window, { type: "get_remote" })).toMatchObject({
    ok: true,
    result: { enabled: false, vault: "unread", hostFingerprint: null, relay: null, devices: [], pairing: null },
  });
  expect(await launched.window.evaluate(() => Object.keys(window.atrium))).not.toContain("vault_read");
});

test("returns keychain failure through real process IPC without blocking local commands", async () => {
  await launched.app.evaluate(({ safeStorage }) => {
    safeStorage.isAsyncEncryptionAvailable = async () => false;
  });
  expect(await request(launched.window, { type: "set_remote", enabled: true })).toMatchObject({
    ok: false,
    error: { code: "keychain_unavailable" },
  });
  expect(await request(launched.window, { type: "get_remote" })).toMatchObject({
    ok: true,
    result: { vault: "keychain_unavailable", hostFingerprint: null, devices: [] },
  });
  expect(await request(launched.window, { type: "set_remote", enabled: false })).toMatchObject({ ok: true });
  expect(await request(launched.window, { type: "ping" })).toMatchObject({ ok: true });
});

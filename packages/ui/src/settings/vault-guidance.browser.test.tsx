import { CommandError } from "@atrium/client";
import type { RemoteState } from "@atrium/protocol";
import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { fakeClient } from "../test/fake-client";
import { PhoneSettings } from "../test/phone-settings";
import "../styles.css";

/** No readable devices; callers decide whether this is a known empty list or an unread vault. */
const STATE: RemoteState = {
  enabled: false,
  vault: "ok",
  hostFingerprint: null,
  relay: null,
  devices: [],
  pairing: null,
};
const KEYCHAIN = "钥匙串暂时无法访问。请允许 Atrium 访问钥匙串；若此前拒绝授权，请重启 Atrium 后再试。";
const UNKNOWN_RESET =
  "已配对设备数量未知。当前无法读取保险箱；继续会永久替换原宿主身份与设备记录，所有手机都需要重新配对。确认重置？";

it("offers a passive status refresh, not a promise to reauthorize or enable remote access", async () => {
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { remote: { ...STATE, vault: "keychain_unavailable" } });
  const screen = await render(<PhoneSettings client={fake.client} />);
  await expect.element(screen.getByText(KEYCHAIN, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重新授权", exact: true })).not.toBeInTheDocument();
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
  await screen.getByRole("button", { name: "刷新状态", exact: true }).click();
  expect(fake.calls).toStrictEqual(["watchRemote true", "watchRemote true"]);
  expect(fake.remote.getState().state?.enabled).toBe(false);
});

it.each(["corrupt", "keychain_unavailable"] as const)(
  "requires two explicit steps and an unknown device count when vault is %s",
  async (vault) => {
    await page.viewport(1280, 820);
    const fake = fakeClient({}, { remote: { ...STATE, vault } });
    const screen = await render(<PhoneSettings client={fake.client} />);
    expect(fake.calls).toStrictEqual(["watchRemote true"]);
    await screen.getByRole("button", { name: /这台 Mac/ }).click();
    await screen.getByRole("button", { name: "撤销全部…" }).click();
    await expect.element(screen.getByText(UNKNOWN_RESET, { exact: true })).toBeVisible();
    expect(screen.container.querySelector(".phone-confirm")?.textContent).not.toContain("0 台");
    expect(screen.container.querySelector(".phone-device-list h4 small")?.textContent).toBe("数量未知");
    expect(fake.calls).toStrictEqual(["watchRemote true"]);
    await screen.getByRole("button", { name: "撤销全部并重新生成", exact: true }).click();
    expect(fake.calls).toStrictEqual(["watchRemote true", "resetRemoteIdentity"]);
  },
);

it("states corrupt-or-key-mismatch rather than asserting a proven physical corruption", async () => {
  const fake = fakeClient({}, { remote: { ...STATE, vault: "corrupt" } });
  const screen = await render(<PhoneSettings client={fake.client} />);
  await expect
    .element(
      screen.getByText("保险箱文件损坏或密钥不匹配，当前无法读取。重置会替换原宿主身份，所有手机都要重新配对。", {
        exact: true,
      }),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "重置", exact: true }).click();
  await expect.element(screen.getByText(UNKNOWN_RESET, { exact: true })).toBeVisible();
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
});

it.each([0, 2])("shows a known readable device count of %s without resetting until confirmed", async (count) => {
  const devices = Array.from({ length: count }, (_, index) => ({
    deviceId: `dev_${String(index).padStart(16, "0")}`,
    name: `Phone ${index}`,
    model: null,
    online: false,
    pairedAt: 1,
    lastSeenAt: null,
    traffic: { up: 0, down: 0 },
  }));
  const fake = fakeClient({}, { remote: { ...STATE, devices } });
  const screen = await render(<PhoneSettings client={fake.client} />);
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("button", { name: "撤销全部…" }).click();
  await expect
    .element(
      screen.getByText(
        `${count} 台设备将断开，原宿主身份与设备记录将永久替换，所有手机都需要重新配对。确认重新生成？`,
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
});

it("uses the same conditional keychain recovery wording for a failed command", async () => {
  const fake = fakeClient(
    {},
    { remote: STATE, remoteCommand: () => Promise.reject(new CommandError("keychain_unavailable")) },
  );
  const screen = await render(<PhoneSettings client={fake.client} />);
  await screen.getByRole("button", { name: /这台 Mac/ }).click();
  await screen.getByRole("switch", { name: "允许手机远程访问" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent(`${KEYCHAIN}重试操作`);
  expect(fake.calls).toStrictEqual(["watchRemote true", "setRemote true"]);
});

it("captures long vault-error and destructive-confirmation wording in both appearances", async () => {
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { remote: { ...STATE, vault: "corrupt" } });
  const oldDark = document.documentElement.classList.contains("dark");
  onTestFinished(() => {
    document.documentElement.classList.toggle("dark", oldDark);
  });
  const screen = await render(<PhoneSettings client={fake.client} />);
  await screen.getByRole("button", { name: "重置", exact: true }).click();
  await expect.element(screen.getByText(UNKNOWN_RESET, { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    screen
      .getByRole("button", { name: "撤销全部并重新生成", exact: true })
      .element()
      .scrollIntoView({ block: "nearest" });
    await screen
      .getByRole("dialog", { name: "设置", exact: true })
      .screenshot({ path: `.vitest/phone-vault-confirm-${theme}.png` });
  }
  fake.remote.setState({ state: { ...STATE, vault: "keychain_unavailable" } });
  await expect.element(screen.getByText(KEYCHAIN, { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    screen.getByText(KEYCHAIN, { exact: true }).element().scrollIntoView({ block: "start" });
    await screen
      .getByRole("dialog", { name: "设置", exact: true })
      .screenshot({ path: `.vitest/phone-keychain-error-${theme}.png` });
  }
  expect(fake.calls).toStrictEqual(["watchRemote true"]);
});

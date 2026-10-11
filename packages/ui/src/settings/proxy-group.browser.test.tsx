import { CommandError, type ProxySetting } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { type FakeAnswers, fakeClient } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/**
 * Renders the settings on the pi part, over a fake client keeping `proxy`.
 *
 * @remarks
 * Through the panel, as the user reaches it.
 *
 * @sideEffects Renders.
 * @param proxy - The proxy the host keeps.
 * @param answers - How some commands answer.
 * @returns The screen, the fake, and the proxy group.
 */
async function proxyGroup(proxy: ProxySetting | null = null, answers: FakeAnswers = {}) {
  // The size of the app's window, which the settings sit in.
  await page.viewport(1280, 820);
  const fake = fakeClient({}, answers);
  fake.index.setState({ preferences: { ...fake.index.getState().preferences, proxy } });
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="pi"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  return { screen, ...fake, group: screen.getByRole("region", { name: "网络代理" }) };
}

/**
 * Fails a save as the host does unexpectedly.
 *
 * @remarks
 * For the fake's `setPreferences`.
 *
 * @sideEffects none
 * @returns A failure.
 */
function failSave(): Promise<void> {
  return Promise.reject(new CommandError("internal_error"));
}

describe("Settings · pi · 网络代理", () => {
  it("keeps a proxy, with hosts that go direct split by lines or commas", async () => {
    const { group, calls } = await proxyGroup();

    await expect
      .element(group)
      .toHaveTextContent(
        "网络代理pi 连模型服务、登录、安装和更新，以及 Atrium 查 pi 的新版本，都走这个代理。不设时沿用终端里的 HTTPS_PROXY。代理地址没有设置不走代理的地址用逗号或换行分开；本机的地址总是直连保存已经在运行的会话不受影响，下次启动 pi 时用新的设置。",
      );
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await expect.element(group.getByRole("button", { name: "不用代理" })).not.toBeInTheDocument();
    await group.getByRole("textbox", { name: "代理地址" }).fill(" http://127.0.0.1:7897 ");
    await group.getByRole("textbox", { name: "不走代理的地址" }).fill(".example.com, localhost\n\n.local,");
    await group.getByRole("button", { name: "保存" }).click();

    await expect.element(group.getByText("已设置")).toBeVisible();
    expect(calls).toStrictEqual([
      'setPreferences {"proxy":{"url":"http://127.0.0.1:7897","noProxy":[".example.com","localhost",".local"]}}',
    ]);
    await expect
      .element(group.getByRole("textbox", { name: "不走代理的地址" }))
      .toHaveValue(".example.com, localhost, .local");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await expect.element(group.getByRole("button", { name: "不用代理" })).toBeEnabled();
  });

  it("starts from the proxy kept, saves only a change, and clears it", async () => {
    const { group, calls } = await proxyGroup({ url: "http://127.0.0.1:7897", noProxy: [".example.com"] });
    const address = group.getByRole("textbox", { name: "代理地址" });

    await expect.element(address).toHaveValue("http://127.0.0.1:7897");
    await expect.element(group.getByRole("textbox", { name: "不走代理的地址" })).toHaveValue(".example.com");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await address.fill("http://127.0.0.1:7897 ");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await group.getByRole("textbox", { name: "不走代理的地址" }).fill(".example.com,");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await group.getByRole("textbox", { name: "不走代理的地址" }).fill(".example.com, .local");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeEnabled();
    await address.fill("");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await address.fill("http://127.0.0.1:7890");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeEnabled();
    await group.getByRole("button", { name: "不用代理" }).click();

    await expect.element(group.getByText("没有设置")).toBeVisible();
    await expect.element(address).toHaveValue("");
    await expect.element(group.getByRole("textbox", { name: "不走代理的地址" })).toHaveValue("");
    await expect.element(group.getByRole("button", { name: "不用代理" })).not.toBeInTheDocument();
    expect(calls).toStrictEqual(['setPreferences {"proxy":null}']);
  });

  it("waits no more once saved, when the host keeps the address in the form it had", async () => {
    const { group, calls } = await proxyGroup({ url: "http://127.0.0.1:7897", noProxy: [] });

    await group.getByRole("textbox", { name: "代理地址" }).fill("HTTP://127.0.0.1:7897/");
    await group.getByRole("button", { name: "保存" }).click();

    await expect
      .poll(() => calls)
      .toStrictEqual(['setPreferences {"proxy":{"url":"HTTP://127.0.0.1:7897/","noProxy":[]}}']);
    await expect.element(group.getByRole("button", { name: "不用代理" })).toBeEnabled();
    await expect.element(group.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("marks the save under way, both buttons waiting", async () => {
    const gate = Promise.withResolvers<void>();
    const { group } = await proxyGroup(
      { url: "http://127.0.0.1:7897", noProxy: [] },
      { setPreferences: () => gate.promise },
    );

    await group.getByRole("textbox", { name: "代理地址" }).fill("http://127.0.0.1:7890");
    await group.getByRole("button", { name: "保存" }).click();

    await expect.element(group.getByRole("button", { name: "保存" })).toBeDisabled();
    await expect.element(group.getByRole("button", { name: "不用代理" })).toBeDisabled();
    gate.resolve();
    await expect.element(group.getByRole("textbox", { name: "代理地址" })).toHaveValue("http://127.0.0.1:7890");
    await expect.element(group.getByRole("button", { name: "不用代理" })).toBeEnabled();
  });

  it.each([
    ["scheme", "只支持 http:// 或 https:// 开头的代理地址"],
    ["credentials", "代理地址里不能带用户名和密码"],
    ["no_proxy", "不走代理的地址里有写不对的一项"],
    ["malformed", "代理地址写得不对，要像 http://127.0.0.1:7897 这样，只写主机和端口"],
  ])("explains a proxy the host refused as %s, keeping what was typed", async (reason, text) => {
    const { group } = await proxyGroup(null, {
      setPreferences: () => Promise.reject(new CommandError("proxy_invalid", { reason })),
    });

    await group.getByRole("textbox", { name: "代理地址" }).fill("socks5://me:pw@127.0.0.1:7897/x");
    await group.getByRole("button", { name: "保存" }).click();

    await expect.element(group.getByRole("alert")).toHaveTextContent(text);
    await expect
      .element(group.getByRole("textbox", { name: "代理地址" }))
      .toHaveValue("socks5://me:pw@127.0.0.1:7897/x");
    await expect.element(group.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("says a save that failed otherwise did not happen, and clears that once tried again", async () => {
    let answer = failSave;
    const { group } = await proxyGroup(null, { setPreferences: () => answer() });

    await group.getByRole("textbox", { name: "代理地址" }).fill("http://127.0.0.1:7897");
    await group.getByRole("button", { name: "保存" }).click();
    await expect.element(group.getByRole("alert")).toHaveTextContent("没保存成功，稍后再试");
    const gate = Promise.withResolvers<void>();
    answer = () => gate.promise;
    await group.getByRole("button", { name: "保存" }).click();

    await expect.element(group.getByRole("alert")).not.toBeInTheDocument();
    gate.resolve();
    await expect.element(group.getByText("已设置")).toBeVisible();
  });
});

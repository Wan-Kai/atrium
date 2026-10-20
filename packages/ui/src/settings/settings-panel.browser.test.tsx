import { describe, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { READY_SETUP, fakeClient } from "../test/fake-client";

/** Where the workbench remembers the settings' part. */
const SECTION_KEY = "atrium.settings.section";

/**
 * Renders the workbench over a fake client, the settings closed.
 *
 * @remarks
 * The settings are reached as the user reaches them. The part remembered is cleared before and
 * after, so tests do not see each other's.
 *
 * @sideEffects Renders; installs the display mode subscription and clears the remembered part
 * until the test ends.
 * @param options - What first launch checks, and the part remembered before.
 * @returns The screen, the fake, and the paths shown in the Finder.
 */
async function workbench(options: { setup?: typeof READY_SETUP; stored?: string } = {}) {
  // The size of the app's window.
  await page.viewport(1280, 820);
  localStorage.removeItem(SECTION_KEY);
  if (options.stored !== undefined) localStorage.setItem(SECTION_KEY, options.stored);
  onTestFinished(() => localStorage.removeItem(SECTION_KEY));
  const fake = fakeClient({}, { setup: options.setup ?? READY_SETUP });
  fake.connection.setState({ hostVersion: "0.1.0" });
  const revealed: string[] = [];
  const screen = await render(
    <Workbench
      client={fake.client}
      status={null}
      pickDirectory={undefined}
      setNativeAppearance={undefined}
      openUrl={() => undefined}
      reveal={(path) => revealed.push(path)}
      pathForFile={undefined}
    />,
  );
  return { screen, ...fake, revealed };
}

/** First launch's checks with pi 0.81.0 out. */
const UPDATE_OUT = { ...READY_SETUP, pi: { ...READY_SETUP.pi, latest: "0.81.0" } };

describe("Settings panel", () => {
  it("opens from the sidebar on appearance at first, and closes with Escape, its button or a click outside", async () => {
    const { screen } = await workbench();
    const dialog = screen.getByRole("dialog", { name: "设置" });

    await expect.element(dialog).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "设置" }).click();
    await expect.element(dialog.getByRole("heading", { level: 2 })).toHaveTextContent("外观");
    await expect.element(dialog).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "设置" }).click();
    await dialog.getByRole("radio", { name: "深色" }).click();
    await expect.element(dialog).toBeVisible();
    await screen.getByRole("button", { name: "关闭设置" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "设置" }).click();
    await screen.getByTestId("settings-scrim").click({ position: { x: 10, y: 10 } });
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it("opens and closes with ⌘, on the part looked at last, remembered across reloads", async () => {
    const { screen } = await workbench();
    const dialog = screen.getByRole("dialog", { name: "设置" });

    await userEvent.keyboard("{Meta>},{/Meta}");
    await dialog.getByRole("button", { name: "关于" }).click();
    await expect.element(dialog.getByRole("button", { name: "关于" })).toHaveAttribute("aria-current", "page");
    await expect.element(dialog.getByRole("button", { name: "外观" })).not.toHaveAttribute("aria-current");
    await userEvent.keyboard("{Meta>},{/Meta}");
    await expect.element(dialog).not.toBeInTheDocument();
    await userEvent.keyboard("{Meta>},{/Meta}");

    await expect.element(dialog.getByRole("heading", { level: 2 })).toHaveTextContent("关于");
    expect(localStorage.getItem(SECTION_KEY)).toBe("about");
  });

  it("does not let the workbench shortcut discard a config draft", async () => {
    const { screen } = await workbench({ stored: "pi" });
    await userEvent.keyboard("{Meta>},{/Meta}");
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await dialog.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await userEvent.keyboard("{Meta>},{/Meta}");
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "继续编辑" }).click();
    await expect.element(dialog.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
    await userEvent.keyboard("{Meta>},{/Meta}");
    await dialog.getByRole("button", { name: "放弃修改" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it("opens on the part remembered from before, or the first when it names none", async () => {
    const first = await workbench({ stored: "projects" });
    await first.screen.getByRole("button", { name: "设置" }).click();
    await expect.element(first.screen.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveTextContent("项目");
    await first.screen.unmount();

    const second = await workbench({ stored: "billing" });
    await second.screen.getByRole("button", { name: "设置" }).click();
    await expect
      .element(second.screen.getByRole("dialog").getByRole("heading", { level: 2 }))
      .toHaveTextContent("外观");
    await expect.element(second.screen.getByRole("radiogroup", { name: "外观" })).toBeVisible();
    await expect
      .element(second.screen.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "外观" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("asks what first launch checks once shown, and marks 设置 and pi while a newer pi is out", async () => {
    const { screen, calls, setup } = await workbench({ setup: UPDATE_OUT });
    const settings = screen.getByRole("button", { name: "设置 pi 有新版本" });

    await expect.element(settings.getByRole("img", { name: "pi 有新版本" })).toBeVisible();
    await settings.click();
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await expect
      .element(dialog.getByRole("button", { name: "pi pi 有新版本" }).getByRole("img", { name: "pi 有新版本" }))
      .toBeVisible();
    expect(dialog.getByRole("img", { name: "pi 有新版本" }).elements()).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("loadSetup"))).toStrictEqual(["loadSetup"]);

    setup.setState({ state: READY_SETUP });
    await expect.element(screen.getByRole("img", { name: "pi 有新版本" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  });

  it("sets the appearance the sidebar's switch sets", async () => {
    const { screen, calls, index } = await workbench();

    await screen.getByRole("button", { name: "设置" }).click();
    const dialog = screen.getByRole("dialog", { name: "设置" });
    await expect.element(dialog.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("radio", { name: "深色" }).click();

    await expect.element(dialog.getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "true");
    await expect.element(dialog.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "false");
    await expect.element(screen.getByRole("button", { name: "外观：深色" })).toBeVisible();
    expect(index.getState().preferences.appearance).toBe("dark");
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"appearance":"dark"}',
    ]);
  });

  it("switches 等你处理 in the sidebar off and on again under 外观", async () => {
    const { screen, calls, index } = await workbench();

    await screen.getByRole("button", { name: "设置" }).click();
    const group = screen.getByRole("dialog", { name: "设置" }).getByRole("region", { name: "侧栏" });
    const toggle = group.getByRole("switch", { name: "显示“等你处理”" });
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    await expect.element(group).toHaveTextContent("侧栏显示“等你处理”在侧栏底部汇总等你审批、回答、授权和出错的会话");
    await toggle.click();

    await expect.element(toggle).toHaveAttribute("aria-checked", "false");
    expect(index.getState().preferences.inbox).toBe(false);
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"inbox":false}',
      'setPreferences {"inbox":true}',
    ]);
  });

  it("shows Atrium's version, the connection, pi's version and the log folder, which it shows in the Finder", async () => {
    const { screen, revealed } = await workbench({ stored: "about" });

    await screen.getByRole("button", { name: "设置" }).click();
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const rows = dialog.getByText(/^(Atrium 版本|连接|pi 版本|日志文件夹)$/);
    await expect.element(rows.nth(3)).toBeVisible();
    expect(rows.elements().map((row) => row.parentElement?.parentElement?.textContent)).toStrictEqual([
      "Atrium 版本0.1.0",
      "连接已连接",
      "pi 版本pi 0.80.0",
      "日志文件夹/Users/test/.atrium/logs在访达中显示",
    ]);
    await dialog.getByRole("button", { name: "在访达中显示" }).click();

    expect(revealed).toStrictEqual(["/Users/test/.atrium/logs"]);
  });

  it("says in the about when the connection to the host is down", async () => {
    const { screen, connection } = await workbench({ stored: "about" });

    await screen.getByRole("button", { name: "设置" }).click();
    connection.setState({ status: "reconnecting", attempt: 2, code: 1006 }, true);

    const label = screen.getByRole("dialog", { name: "设置" }).getByText("连接", { exact: true });

    await expect
      .poll(() => label.element().parentElement?.parentElement?.textContent)
      .toBe("连接与宿主的连接已断开，正在重连（第 2 次）…");
  });
});

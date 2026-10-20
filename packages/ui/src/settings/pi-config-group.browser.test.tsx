import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { CommandError } from "@atrium/client";
import type { PiConfigFile } from "@atrium/protocol";
import "../styles.css";
import { fakeClient, workspace } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/**
 * Opens pi settings for a config scenario.
 * @remarks Exercises the editor through its containing panel.
 * @sideEffects Renders the panel.
 * @param fake - A client with the scenario's config responses.
 */
async function show(fake = fakeClient()) {
  await page.viewport(1280, 820);
  let closed = 0;
  const sections: string[] = [];
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="pi"
      onSection={(next) => sections.push(next)}
      onClose={() => {
        closed++;
      }}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  return { screen, fake, sections, closed: () => closed };
}

/**
 * Supplies successive config responses, including recoverable failures.
 * @remarks The scripted order keeps retry tests deterministic.
 * @sideEffects Consumes one response for each call.
 * @param responses - The read or write results in call order.
 */
function sequence(...responses: (PiConfigFile | Error | Promise<PiConfigFile>)[]): () => Promise<PiConfigFile> {
  return async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("Unexpected config call");
    return next;
  };
}

describe("pi config editor", () => {
  it("opens a missing file and creates it without requiring an edit", async () => {
    const { screen, fake } = await show();
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue("{}\n");
    expect(
      screen.getByRole("textbox", { name: "配置内容" }).element().getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(256);
    await expect.element(screen.getByText("/Users/test/.pi/agent/settings.json", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("文件尚不存在，保存时创建")).toBeVisible();
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(fake.configCalls).toContain("savePiConfig null settings.json");
  });

  it("repairs invalid existing JSON, preserves whitespace and sends the original revision", async () => {
    const writes: unknown[][] = [];
    const fake = fakeClient(
      {},
      {
        readPiConfig: async () => ({ path: "/actual/config/settings.json", text: '{"broken":', revision: "original" }),
        savePiConfig: async (...args) => {
          writes.push(args);
          return { path: "/actual/config/settings.json", text: args[2], revision: "next" };
        },
      },
    );
    const { screen } = await show(fake);
    const text = screen.getByRole("textbox", { name: "配置内容" });
    await expect.element(text).toHaveValue('{"broken":');
    await text.fill("");
    await userEvent.type(text, '{{ "fixed": true }{Enter}');
    await expect.element(text).toHaveFocus();
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(writes).toStrictEqual([[null, "settings.json", '{ "fixed": true }\n', "original"]]);
    await expect.element(text).toHaveValue('{ "fixed": true }\n');
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  });

  it("validates syntax, root object and byte limit without exposing parser errors", async () => {
    const { screen, fake } = await show();
    const text = screen.getByRole("textbox", { name: "配置内容" });
    for (const value of ['{"secret":', "[]", "null", '"text"', " \n", "\uFEFF"]) {
      await text.fill(value);
      await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
      await expect.element(screen.getByRole("alert")).toHaveTextContent("请输入有效的 JSON 对象");
    }
    await text.fill('{"汉":"' + "汉".repeat(90000) + '"}');
    await expect.element(screen.getByRole("alert")).toHaveTextContent("配置不能超过 256 KiB");
    expect(fake.configCalls.some((call) => call.startsWith("savePiConfig"))).toBe(false);
  });

  it("protects drafts on close, keyboard, scrim, section, file and reload", async () => {
    const { screen, sections, closed } = await show();
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("button", { name: "关闭设置" }).click();
    await expect.element(screen.getByText("有未保存的配置修改，放弃修改？")).toBeVisible();
    expect(closed()).toBe(0);
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await userEvent.keyboard("{Escape}");
    expect(closed()).toBe(0);
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await userEvent.keyboard("{Meta>},{/Meta}");
    expect(closed()).toBe(0);
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await screen.getByTestId("settings-scrim").click({ position: { x: 5, y: 5 } });
    expect(closed()).toBe(0);
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await screen.getByRole("button", { name: "关于", exact: true }).click();
    expect(sections).toStrictEqual([]);
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("models.json");
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
    await screen.getByRole("button", { name: "重新读取", exact: true }).click();
    await screen.getByRole("button", { name: "放弃修改" }).click();
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue("{}\n");
  });

  it("keeps a conflict draft until confirmed reload and allows retry after save failure", async () => {
    const fake = fakeClient(
      {},
      {
        savePiConfig: sequence(new CommandError("config_conflict", {}), new CommandError("read_failed", {}), {
          path: "/config/settings.json",
          text: '{"draft":true}',
          revision: "v2",
        }),
      },
    );
    const { screen } = await show(fake);
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("文件已在别处修改，草稿已保留。请重新读取后再保存");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("读写配置失败，请重试");
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
  });

  it("limits project files to settings and mcp and disables project scope without a workspace", async () => {
    const first = await show();
    await expect.element(first.screen.getByRole("option", { name: "当前工作区" })).toBeDisabled();
    await first.screen.unmount();
    const fake = fakeClient({ workspaces: [workspace({ id: "wks_a" })], layout: { container: "wks_a", tabs: {} } });
    const { screen } = await show(fake);
    await screen.getByRole("combobox", { name: "配置作用域" }).selectOptions("wks_a");
    await expect
      .poll(() => screen.getByRole("combobox", { name: "配置文件" }).element().textContent)
      .toBe("settings.jsonmcp.json");
    expect(fake.configCalls).toContain("readPiConfig wks_a settings.json");
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"project":true}');
    await screen.getByRole("combobox", { name: "配置作用域" }).selectOptions("global");
    await screen.getByRole("button", { name: "继续编辑" }).click();
    await expect.element(screen.getByRole("combobox", { name: "配置作用域" })).toHaveValue("wks_a");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"project":true}');
    await screen.getByRole("combobox", { name: "配置作用域" }).selectOptions("global");
    await screen.getByRole("button", { name: "放弃修改" }).click();
    await expect.element(screen.getByRole("combobox", { name: "配置作用域" })).toHaveValue("global");
  });

  it("preserves BOM and consistent CRLF bytes while editing normalized text", async () => {
    const writes: unknown[][] = [];
    const fake = fakeClient(
      {},
      {
        readPiConfig: async () => ({
          path: "/config/settings.json",
          text: '\uFEFF{\r\n  "old": true\r\n}\r\n',
          revision: "original",
        }),
        savePiConfig: async (...args) => {
          writes.push(args);
          return { path: "/config/settings.json", text: args[2], revision: "saved" };
        },
      },
    );
    const { screen } = await show(fake);
    const text = screen.getByRole("textbox", { name: "配置内容" });
    await expect.element(text).toHaveValue('{\n  "old": true\n}\n');
    await text.fill('{\n  "new": true\n}\n');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(writes).toStrictEqual([[null, "settings.json", '\uFEFF{\r\n  "new": true\r\n}\r\n', "original"]]);
    await expect.element(text).toHaveValue('{\n  "new": true\n}\n');
  });

  it("allows empty settings and delegates models JSONC validation to the host", async () => {
    const { screen, fake } = await show();
    await screen.getByRole("textbox", { name: "配置内容" }).fill("");
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("models.json");
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{ // comment\n "providers": {},\n}');
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(fake.configCalls).toContain("savePiConfig null models.json");
  });

  it("surfaces host models validation and still checks models byte size locally", async () => {
    const { screen, fake } = await show(
      fakeClient({}, { savePiConfig: sequence(new CommandError("config_invalid", {})) }),
    );
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("models.json");
    await screen.getByRole("textbox", { name: "配置内容" }).fill("[]");
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("请输入有效的 JSON 对象");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue("[]");
    await screen.getByRole("textbox", { name: "配置内容" }).fill("汉".repeat(90000));
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("配置不能超过 256 KiB");
    expect(fake.configCalls.filter((call) => call.startsWith("savePiConfig"))).toStrictEqual([
      "savePiConfig null models.json",
    ]);
  });

  it.each(["{\n}\n", "{\r\n}\n"])("uses LF after editing LF or mixed newline files (%j)", async (original) => {
    const writes: unknown[][] = [];
    const fake = fakeClient(
      {},
      {
        readPiConfig: async () => ({ path: "/config/settings.json", text: original, revision: "old" }),
        savePiConfig: async (...args) => {
          writes.push(args);
          return { path: "/config/settings.json", text: args[2], revision: "saved" };
        },
      },
    );
    const { screen } = await show(fake);
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{\n "new": true\n}\n');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(writes).toStrictEqual([[null, "settings.json", '{\n "new": true\n}\n', "old"]]);
  });

  it("ignores stale reads and retries read failure", async () => {
    let finish: ((file: { path: string; text: string; revision: string | null }) => void) | undefined;
    const fake = fakeClient(
      {},
      {
        readPiConfig: sequence(
          new Promise((resolve) => {
            finish = resolve;
          }),
          new CommandError("config_unavailable", {}),
          { path: "/config/mcp.json", text: '{"new":true}', revision: "new" },
        ),
      },
    );
    const { screen } = await show(fake);
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("mcp.json");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("暂时无法取得 pi 的配置目录，请重试");
    await screen.getByRole("button", { name: "重试读取" }).click();
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"new":true}');
    finish?.({ path: "/stale", text: "{}", revision: "old" });
    // A real browser interaction flushes the stale promise and React update before the assertion.
    await screen.getByRole("textbox", { name: "配置内容" }).click();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"new":true}');
  });

  it("ignores stale read failures after switching files", async () => {
    let fail: ((error: Error) => void) | undefined;
    const fake = fakeClient(
      {},
      {
        readPiConfig: sequence(
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
          {
            path: "/config/mcp.json",
            text: '{"new":true}',
            revision: "new",
          },
        ),
      },
    );
    const { screen } = await show(fake);
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("mcp.json");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"new":true}');
    fail?.(new CommandError("config_unavailable", {}));
    await screen.getByRole("textbox", { name: "配置内容" }).click();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"new":true}');
  });

  it("retains a disconnected save draft and retries with the original revision", async () => {
    const writes: unknown[][] = [];
    const response = sequence(new Error("Disconnected"), {
      path: "/config/settings.json",
      text: '{"draft":true}',
      revision: "new",
    });
    const fake = fakeClient(
      {},
      {
        readPiConfig: async () => ({ path: "/config/settings.json", text: "{}", revision: "old" }),
        savePiConfig: async (...args) => {
          writes.push(args);
          return response();
        },
      },
    );
    const { screen } = await show(fake);
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("读写配置失败，请重试");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(writes).toStrictEqual(Array.from({ length: 2 }, () => [null, "settings.json", '{"draft":true}', "old"]));
  });

  it("excludes removed workspaces and keeps an editing scope pinned", async () => {
    const fake = fakeClient({ workspaces: [workspace({ id: "wks_a" })], layout: { container: "wks_a", tabs: {} } });
    const { screen } = await show(fake);
    await screen.getByRole("combobox", { name: "配置作用域" }).selectOptions("wks_a");
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    fake.index.setState({
      workspaces: [workspace({ id: "wks_a" }), workspace({ id: "wks_b" })],
      layout: { container: "wks_b", tabs: {} },
    });
    await expect.element(screen.getByRole("combobox", { name: "配置作用域" })).toHaveValue("wks_a");
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
    expect(fake.configCalls).toContain("savePiConfig wks_a settings.json");
    fake.index.setState({
      workspaces: [workspace({ id: "wks_a", merge: { dirty: false, ahead: 0, verdict: "removed", reason: null } })],
      layout: { container: "wks_a", tabs: {} },
    });
    await expect.element(screen.getByRole("option", { name: "当前工作区", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("combobox", { name: "配置作用域" })).toHaveValue("wks_a");
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
  });

  it("gives actionable guidance for invalid UTF-8 rather than suggesting retry", async () => {
    const { screen } = await show(fakeClient({}, { readPiConfig: sequence(new CommandError("config_encoding", {})) }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("配置不是有效的 UTF-8，请用外部编辑器转换为 UTF-8 后重新读取");
  });

  it("shares one discard confirmation across file and section exits and locks save", async () => {
    const { screen, sections, fake } = await show();
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("models.json");
    await screen.getByRole("button", { name: "关于", exact: true }).click();
    expect(screen.getByText("有未保存的配置修改，放弃修改？").elements()).toHaveLength(1);
    await expect.element(screen.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await screen.getByRole("button", { name: "放弃修改" }).click();
    expect(sections).toStrictEqual(["about"]);
    expect(fake.configCalls).toStrictEqual(["readPiConfig null settings.json"]);
  });

  it("cannot start saving while a file-discard confirmation is open", async () => {
    const { screen, fake } = await show();
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("combobox", { name: "配置文件" }).selectOptions("models.json");
    const save = screen.getByRole("button", { name: "保存配置", exact: true });
    await expect.element(save).toBeDisabled();
    save.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fake.configCalls).toStrictEqual(["readPiConfig null settings.json"]);
    await expect.element(screen.getByRole("textbox", { name: "配置内容" })).toHaveValue('{"draft":true}');
    await screen.getByRole("button", { name: "放弃修改" }).click();
    await expect.element(screen.getByRole("combobox", { name: "配置文件" })).toHaveValue("models.json");
    expect(fake.configCalls).toStrictEqual(["readPiConfig null settings.json", "readPiConfig null models.json"]);
  });

  it("blocks close and switches while a save is pending", async () => {
    let finish: (() => void) | undefined;
    const fake = fakeClient(
      {},
      {
        savePiConfig: async (_scope, name, text) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { path: `/config/${name}`, text, revision: "saved" };
        },
      },
    );
    const { screen, closed } = await show(fake);
    await screen.getByRole("textbox", { name: "配置内容" }).fill('{"draft":true}');
    await screen.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "关闭设置" })).toBeDisabled();
    await expect.element(screen.getByRole("combobox", { name: "配置文件" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "关于", exact: true })).toBeDisabled();
    await screen.getByTestId("settings-scrim").click({ position: { x: 5, y: 5 } });
    await userEvent.keyboard("{Escape}{Meta>},{/Meta}");
    expect(closed()).toBe(0);
    finish?.();
    await expect.element(screen.getByText("已保存", { exact: true })).toBeVisible();
  });
});

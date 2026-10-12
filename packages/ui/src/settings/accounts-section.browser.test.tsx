import type { ModelListView } from "@atrium/client";
import { type CatalogModel, CommandError, type LoginUpdatedEvent, type SetupProvider } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { READY_SETUP, fakeClient } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/**
 * A provider as first launch lists it.
 *
 * @remarks
 * Signed in nowhere, with neither OAuth nor a key, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param providerId - pi's id.
 * @param name - pi's name.
 * @param fields - Fields to set.
 * @returns The provider.
 */
function provider(providerId: string, name: string, fields: Partial<SetupProvider> = {}): SetupProvider {
  return { providerId, name, oauth: null, apiKey: false, signedIn: null, ...fields };
}

const OPENAI = provider("openai", "OpenAI", {
  oauth: { label: "ChatGPT Plus/Pro (Codex Subscription)", subscription: true },
  apiKey: true,
});
const CLAUDE = provider("anthropic", "Anthropic", {
  oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true },
  apiKey: true,
  signedIn: { method: "oauth", stored: true },
});
const DEEPSEEK = provider("deepseek", "DeepSeek", { apiKey: true });
const GOOGLE = provider("google", "Google", { apiKey: true });

/**
 * Renders the settings on the models and accounts part, over a fake client listing `providers`.
 *
 * @remarks
 * Through the panel, as the user reaches it; the setup is asked for first, as the workbench does.
 *
 * @sideEffects Renders.
 * @param providers - pi's providers; `null` when Atrium cannot log in through pi.
 * @param options - How some commands answer, and the list to start from.
 * @returns The screen, the fake, and the addresses opened.
 */
async function accounts(
  providers: readonly SetupProvider[] | null,
  options: { answers?: Parameters<typeof fakeClient>[1]; initial?: Parameters<typeof fakeClient>[0] } = {},
) {
  // The size of the app's window, which the settings sit in.
  await page.viewport(1280, 820);
  const login =
    providers === null ? { state: "unavailable" as const } : { state: "ready" as const, providers: [...providers] };
  const fake = fakeClient(options.initial, { ...options.answers, setup: { ...READY_SETUP, login } });
  await fake.client.loadSetup();
  fake.calls.length = 0;
  const opened: string[] = [];
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="accounts"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={(url) => opened.push(url)}
      reveal={undefined}
    />,
  );
  return { screen, ...fake, opened };
}

/**
 * A login's state as the host reports it.
 *
 * @remarks
 * Running, with nothing to show yet, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param fields - The login, provider and method, and fields to set.
 * @returns The state.
 */
function loginEvent(
  fields: Partial<LoginUpdatedEvent> & Pick<LoginUpdatedEvent, "loginId" | "providerId" | "method">,
): LoginUpdatedEvent {
  return {
    type: "login_updated",
    state: "running",
    authUrl: null,
    deviceCode: null,
    questions: [],
    progress: null,
    error: null,
    ...fields,
  };
}

/** A model as the catalog lists it. */
function model(providerId: string, modelId: string): CatalogModel {
  return {
    providerId,
    modelId,
    name: modelId,
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsImage: true,
    thinkingLevels: [],
    fastCredits: null,
  };
}

describe("Settings · models and accounts", () => {
  it("lists the subscriptions pi offers in SPEC-0001's order, signed-in ones with 退出", async () => {
    const { screen } = await accounts([CLAUDE, DEEPSEEK, OPENAI]);
    const group = screen.getByRole("region", { name: "订阅登录" });

    expect(
      group
        .getByText(/^(ChatGPT|Claude)$/)
        .elements()
        .map((title) => title.textContent),
    ).toStrictEqual(["ChatGPT", "Claude"]);
    await expect.element(group.getByRole("button", { name: "登录 ChatGPT" })).toBeVisible();
    await expect.element(group.getByRole("button", { name: "登录 Claude" })).not.toBeInTheDocument();
    await expect.element(group.getByText("已登录")).toBeVisible();
    await expect.element(group.getByRole("button", { name: "退出 Claude" })).toBeVisible();
  });

  it("opens the authorisation page of a login it started, once, and offers it again", async () => {
    const { screen, calls, loginState, opened } = await accounts([OPENAI, CLAUDE]);

    await screen.getByRole("button", { name: "登录 ChatGPT" }).click();
    const authUrl = { url: "https://auth.openai.com/authorize?state=x", instructions: null };
    loginState.setState(loginEvent({ loginId: "l1", providerId: "openai", method: "oauth", authUrl }), true);
    await expect.element(screen.getByText("在浏览器中完成登录")).toBeVisible();
    loginState.setState(
      loginEvent({
        loginId: "l1",
        providerId: "openai",
        method: "oauth",
        authUrl,
        progress: "Waiting for the browser",
      }),
      true,
    );
    await expect.element(screen.getByText("Waiting for the browser")).toBeVisible();
    const again = { url: "https://auth.openai.com/authorize?state=z", instructions: null };
    loginState.setState(loginEvent({ loginId: "l1", providerId: "openai", method: "oauth", authUrl: again }), true);
    await expect.element(screen.getByText("Waiting for the browser")).not.toBeInTheDocument();
    expect(opened).toStrictEqual([authUrl.url]);

    await screen.getByRole("button", { name: "打开授权页" }).click();
    expect(opened).toStrictEqual([authUrl.url, again.url]);
    await screen.getByRole("button", { name: "取消" }).click();
    expect(calls).toStrictEqual(["login openai oauth", "cancelLogin l1"]);
  });

  it("shows a login another window started without opening its page", async () => {
    const { screen, loginState, opened } = await accounts([OPENAI, CLAUDE]);

    // This window started one before, which the other window's replaced.
    await screen.getByRole("button", { name: "登录 ChatGPT" }).click();
    const authUrl = { url: "https://auth.openai.com/authorize?state=y", instructions: null };
    loginState.setState(loginEvent({ loginId: "l9", providerId: "openai", method: "oauth", authUrl }), true);

    await expect.element(screen.getByText("在浏览器中完成登录")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "登录 ChatGPT" })).not.toBeInTheDocument();
    expect(opened).toStrictEqual([]);
  });

  it("shows a device code to copy and its page, and answers pi's questions", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const { screen, calls, loginState, opened } = await accounts([OPENAI, CLAUDE]);

    await screen.getByRole("button", { name: "登录 ChatGPT" }).click();
    loginState.setState(
      loginEvent({
        loginId: "l1",
        providerId: "openai",
        method: "oauth",
        deviceCode: {
          userCode: "WXYZ-1234",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
        questions: [
          {
            promptId: 1,
            kind: "select",
            message: "Which workspace?",
            placeholder: null,
            options: [
              { id: "personal", label: "Personal" },
              { id: "team", label: "Team" },
            ],
          },
          { promptId: 2, kind: "text", message: "Enterprise domain", placeholder: "example.com", options: [] },
          { promptId: 3, kind: "manual_code", message: "Paste the redirect URL", placeholder: null, options: [] },
        ],
      }),
      true,
    );

    await expect.element(screen.getByLabelText("设备码")).toHaveTextContent("WXYZ-1234");
    await screen.getByRole("button", { name: "复制" }).click();
    await expect.element(screen.getByRole("button", { name: "已复制" })).toBeVisible();
    await screen.getByRole("button", { name: "打开验证页" }).click();
    await screen.getByRole("group", { name: "Which workspace?" }).getByRole("button", { name: "Team" }).click();
    await screen.getByLabelText("Enterprise domain").fill("acme.dev");
    await screen.getByRole("button", { name: "确定" }).click();
    const manual = screen.getByRole("button", { name: "浏览器在别的电脑上？粘贴回调地址" });
    await expect.element(screen.getByLabelText("回调地址")).not.toBeInTheDocument();
    await manual.click();
    await screen.getByLabelText("回调地址").fill("http://localhost:1455/auth/callback?code=c");
    await screen.getByRole("button", { name: "确定" }).nth(1).click();

    expect(written).toStrictEqual(["WXYZ-1234"]);
    expect(opened).toStrictEqual(["https://github.com/login/device"]);
    expect(calls).toStrictEqual([
      "login openai oauth",
      "answerLogin l1 1 team",
      "answerLogin l1 2 acme.dev",
      "answerLogin l1 3 http://localhost:1455/auth/callback?code=c",
    ]);
  });

  it("says why a login failed, with pi's own words under it", async () => {
    const { screen, loginState } = await accounts([OPENAI, CLAUDE]);

    loginState.setState(
      loginEvent({
        loginId: "l1",
        providerId: "openai",
        method: "oauth",
        state: "failed",
        error: { reason: "timed_out", detail: "no callback within 5 minutes" },
      }),
      true,
    );

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("等得太久，登录已取消no callback within 5 minutes");
    await expect.element(screen.getByRole("button", { name: "登录 ChatGPT" })).toBeVisible();
  });

  it("says when a login cannot start", async () => {
    const answers = { login: () => Promise.reject(new CommandError("login_unavailable")) };
    const { screen } = await accounts([OPENAI, CLAUDE], { answers });

    await screen.getByRole("button", { name: "登录 ChatGPT" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("登录用不了：Atrium 加载不了你装的 pi");
  });

  it("removes a subscription's key from its key row, not its subscription row", async () => {
    const keyed = { ...OPENAI, signedIn: { method: "api_key" as const, stored: true } };
    const { screen, calls } = await accounts([keyed, CLAUDE]);
    const subscriptions = screen.getByRole("region", { name: "订阅登录" });

    await expect.element(subscriptions.getByRole("button", { name: "登录 ChatGPT" })).not.toBeInTheDocument();
    expect(subscriptions.getByText("已登录").elements()).toHaveLength(2);
    await expect.element(subscriptions.getByRole("button", { name: "退出 ChatGPT" })).not.toBeInTheDocument();
    await screen.getByRole("region", { name: "API Key" }).getByRole("button", { name: "删除 OpenAI" }).click();

    expect(calls).toStrictEqual(["logout openai"]);
  });

  it("shows no login trouble on a row already signed in", async () => {
    const { screen, loginState } = await accounts([CLAUDE, OPENAI]);

    loginState.setState(
      loginEvent({
        loginId: "l9",
        providerId: "anthropic",
        method: "oauth",
        state: "failed",
        error: { reason: "failed", detail: "refused" },
      }),
      true,
    );
    await expect.element(screen.getByRole("button", { name: "退出 Claude" })).toBeVisible();

    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("logs out at once while another credential remains", async () => {
    const keyed = { ...DEEPSEEK, signedIn: { method: "api_key" as const, stored: true } };
    const { screen, calls } = await accounts([CLAUDE, keyed]);

    await screen.getByRole("button", { name: "退出 Claude" }).click();

    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(calls).toStrictEqual(["logout anthropic"]);
  });

  it("asks before the last credential goes, and lets it go or stay", async () => {
    const { screen, calls } = await accounts([CLAUDE, OPENAI]);
    const out = screen.getByRole("button", { name: "退出 Claude" });

    await out.click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("退出后没有能用的模型，新会话没法开始");
    await screen.getByRole("button", { name: "取消" }).click();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(calls).toStrictEqual([]);
    await out.click();
    await screen.getByRole("button", { name: "仍要退出" }).click();

    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(calls).toStrictEqual(["logout anthropic"]);
  });

  it("says when pi could not log out", async () => {
    const keyed = { ...DEEPSEEK, signedIn: { method: "api_key" as const, stored: true } };
    const answers = { logout: () => Promise.reject(new CommandError("logout_failed")) };
    const { screen } = await accounts([CLAUDE, keyed], { answers });

    await screen.getByRole("button", { name: "退出 Claude" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 没能去掉 Claude 的凭据");
  });

  it("lists keys by provider, a stored one removable and one from the environment not", async () => {
    const stored = { ...DEEPSEEK, signedIn: { method: "api_key" as const, stored: true } };
    const fromEnvironment = { ...GOOGLE, signedIn: { method: "api_key" as const, stored: false } };
    const { screen, calls } = await accounts([fromEnvironment, stored]);
    const group = screen.getByRole("region", { name: "API Key" });

    expect(
      group
        .getByText(/^(DeepSeek|Google)$/)
        .elements()
        .map((name) => name.textContent),
    ).toStrictEqual(["DeepSeek", "Google"]);
    await expect.element(group.getByText("已保存")).toBeVisible();
    await expect.element(group.getByText("来自环境变量")).toBeVisible();
    await expect.element(group.getByRole("button", { name: "删除 Google" })).not.toBeInTheDocument();
    await group.getByRole("button", { name: "删除 DeepSeek" }).click();

    expect(calls).toStrictEqual(["logout deepseek"]);
  });

  it("asks before deleting the last key", async () => {
    const stored = { ...DEEPSEEK, signedIn: { method: "api_key" as const, stored: true } };
    const { screen, calls } = await accounts([stored]);

    await screen.getByRole("button", { name: "删除 DeepSeek" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("删除后没有能用的模型，新会话没法开始");
    await screen.getByRole("button", { name: "仍要删除" }).click();

    expect(calls).toStrictEqual(["logout deepseek"]);
  });

  it("adds a key: asks for one first, logs in with it, and closes once saved", async () => {
    const { screen, calls, loginState } = await accounts([OPENAI, DEEPSEEK, CLAUDE]);

    await screen.getByRole("button", { name: "添加 API Key" }).click();
    const providers = screen.getByRole("combobox", { name: "服务商" });
    expect(
      providers
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toStrictEqual(["DeepSeek", "OpenAI"]);
    await screen.getByRole("textbox", { name: "API Key" }).fill("   ");
    await screen.getByRole("button", { name: "保存" }).click();
    await expect.element(screen.getByText("先粘贴 Key 再保存")).toBeVisible();
    expect(calls).toStrictEqual([]);

    await providers.selectOptions("OpenAI");
    await screen.getByRole("textbox", { name: "API Key" }).fill("  sk-test  ");
    await screen.getByRole("button", { name: "保存" }).click();
    await expect.element(screen.getByText("粘贴后按回车或点“保存”")).toBeVisible();
    loginState.setState(loginEvent({ loginId: "l1", providerId: "openai", method: "api_key" }), true);
    await expect.element(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "登录 ChatGPT" })).toBeVisible();
    await expect.element(screen.getByText("在浏览器中完成登录")).not.toBeInTheDocument();
    loginState.setState(loginEvent({ loginId: "l1", providerId: "openai", method: "api_key", state: "ok" }), true);

    await expect.element(screen.getByRole("button", { name: "添加 API Key" })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "API Key" })).not.toBeInTheDocument();
    expect(calls).toStrictEqual(["login openai api_key sk-test"]);
  });

  it("keeps the key form open with pi's reason when the key is refused", async () => {
    const { screen, loginState } = await accounts([DEEPSEEK, CLAUDE]);

    await screen.getByRole("button", { name: "添加 API Key" }).click();
    await screen.getByRole("textbox", { name: "API Key" }).fill("sk-bad");
    await screen.getByRole("button", { name: "保存" }).click();
    loginState.setState(
      loginEvent({
        loginId: "l1",
        providerId: "deepseek",
        method: "api_key",
        state: "failed",
        error: { reason: "failed", detail: "401 invalid key" },
      }),
      true,
    );

    await expect.element(screen.getByRole("alert")).toHaveTextContent("没有登录成功401 invalid key");
    await expect.element(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    await screen.getByRole("button", { name: "取消" }).click();
    await expect.element(screen.getByRole("textbox", { name: "API Key" })).not.toBeInTheDocument();
  });

  it("leaves the key form open while a key saved in another window goes in", async () => {
    const { screen, loginState } = await accounts([DEEPSEEK, CLAUDE]);

    await screen.getByRole("button", { name: "添加 API Key" }).click();
    loginState.setState(loginEvent({ loginId: "l9", providerId: "deepseek", method: "api_key", state: "ok" }), true);
    loginState.setState(
      loginEvent({
        loginId: "l9",
        providerId: "deepseek",
        method: "api_key",
        state: "failed",
        error: { reason: "failed", detail: null },
      }),
      true,
    );

    await expect.element(screen.getByRole("textbox", { name: "API Key" })).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("offers no key to add when every provider that takes one is signed in", async () => {
    const { screen } = await accounts([CLAUDE]);

    await expect.element(screen.getByRole("button", { name: "添加 API Key" })).toBeDisabled();
  });

  it("points to the terminal when Atrium cannot log in through pi", async () => {
    const { screen } = await accounts(null);

    await expect
      .element(screen.getByRole("region", { name: "登录" }))
      .toHaveTextContent("登录Atrium 加载不了你装的 pi，没法在这里登录。在终端运行 pi，输入 /login。");
    await expect.element(screen.getByRole("region", { name: "订阅登录" })).not.toBeInTheDocument();
  });

  it("chooses the title model from the chats' models, or the session's", async () => {
    const models: ModelListView = {
      status: "ready",
      models: [model("anthropic", "claude-haiku-4-5"), model("openai", "gpt-6-mini")],
      defaultModel: null,
      error: null,
    };
    const { screen, calls, modelCalls } = await accounts([CLAUDE], { answers: { models } });
    const menu = screen.getByRole("button", { name: "生成标题用的模型" });

    await expect.element(menu).toHaveTextContent("跟随会话的模型");
    await menu.click();
    expect(
      screen
        .getByRole("group")
        .elements()
        .map((group) => group.getAttribute("aria-label")),
    ).toStrictEqual(["Anthropic", "OpenAI"]);
    await expect
      .element(screen.getByRole("menuitemradio", { name: /^跟随会话的模型/ }))
      .toHaveAttribute("aria-checked", "true");
    await screen.getByRole("menuitemradio", { name: "gpt-6-mini" }).click();
    await expect.element(menu).toHaveTextContent("gpt-6-miniOpenAI");
    await menu.click();
    await expect
      .element(screen.getByRole("menuitemradio", { name: "gpt-6-mini" }))
      .toHaveAttribute("aria-checked", "true");
    await screen.getByRole("menuitemradio", { name: /^跟随会话的模型/ }).click();
    await expect.element(menu).toHaveTextContent("跟随会话的模型");

    expect(modelCalls).toStrictEqual(["loadModels null"]);
    expect(calls).toStrictEqual([
      'setPreferences {"titleModel":{"providerId":"openai","modelId":"gpt-6-mini"}}',
      'setPreferences {"titleModel":null}',
    ]);
  });

  it("notes a chosen title model pi no longer lists, once the list is read", async () => {
    const preferences = {
      setupDone: true,
      appearance: "system" as const,
      displayMode: "summary" as const,
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: { providerId: "openai", modelId: "gpt-5-mini" },
      proxy: null,
    };
    const models: ModelListView = {
      status: "ready",
      models: [model("anthropic", "claude-haiku-4-5")],
      defaultModel: null,
      error: null,
    };
    const { screen } = await accounts([CLAUDE], { answers: { models }, initial: { preferences } });

    await expect.element(screen.getByText("已不可用，暂时改用会话的模型起标题")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "生成标题用的模型" }))
      .toHaveTextContent("gpt-5-miniOpenAI");
  });

  it("tells apart models of the same name from different providers", async () => {
    const preferences = {
      setupDone: true,
      appearance: "system" as const,
      displayMode: "summary" as const,
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: { providerId: "openrouter", modelId: "claude-haiku-4-5" },
      proxy: null,
    };
    const models: ModelListView = {
      status: "ready",
      models: [model("anthropic", "claude-haiku-4-5"), model("openrouter", "claude-haiku-4-5")],
      defaultModel: null,
      error: null,
    };
    const { screen } = await accounts([CLAUDE], { answers: { models }, initial: { preferences } });

    await screen.getByRole("button", { name: "生成标题用的模型" }).click();

    await expect
      .element(screen.getByRole("group", { name: "Anthropic" }).getByRole("menuitemradio"))
      .toHaveAttribute("aria-checked", "false");
    await expect
      .element(screen.getByRole("group", { name: "OpenRouter" }).getByRole("menuitemradio"))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(screen.getByText("已不可用，暂时改用会话的模型起标题")).not.toBeInTheDocument();
  });

  it("waits for the models before saying a chosen one is gone", async () => {
    const preferences = {
      setupDone: true,
      appearance: "system" as const,
      displayMode: "summary" as const,
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: { providerId: "openai", modelId: "gpt-5-mini" },
      proxy: null,
    };
    const models: ModelListView = { status: "loading", models: [], defaultModel: null, error: null };
    const { screen } = await accounts([CLAUDE], { answers: { models }, initial: { preferences } });

    await screen.getByRole("button", { name: "生成标题用的模型" }).click();

    await expect.element(screen.getByText("正在读取模型…")).toBeVisible();
    await expect.element(screen.getByText("已不可用，暂时改用会话的模型起标题")).not.toBeInTheDocument();
  });

  it("says when the providers cannot be read", async () => {
    const fake = fakeClient();
    fake.setup.setState({ status: "failed", state: null, error: new Error("closed") });
    const screen = await render(
      <SettingsPanel
        client={fake.client}
        section="accounts"
        onSection={() => undefined}
        onClose={() => undefined}
        openUrl={() => undefined}
        reveal={undefined}
      />,
    );

    await expect.element(screen.getByText("读不到登录状态")).toBeVisible();
    fake.setup.setState({ status: "loading" });
    await expect.element(screen.getByText("正在读取…")).toBeVisible();
  });
});

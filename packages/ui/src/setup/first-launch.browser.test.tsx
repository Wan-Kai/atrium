import type { InstallJob } from "@atrium/client";
import {
  CommandError,
  type DiscoveredDirectory,
  type InstallUpdatedEvent,
  type SetupProvider,
  type SetupState,
} from "@atrium/protocol";
import { StrictMode } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import atriumLogo from "../design/brand/atrium.svg";
import { Workbench } from "../app/workbench";
import { ClockContext, type UiClock } from "../state/clock";
import { READY_SETUP, fakeClient } from "../test/fake-client";
import { FirstLaunch, type FirstLaunchStart } from "./first-launch";

/** The connection once the host said welcome. */
const CONNECTED = {
  status: "connected",
  traceId: "t",
  hostVersion: "0",
  hostInstanceId: "h1",
  installSeed: 1,
  logDir: "/logs",
} as const;

/** The time the tests run at: 2027-01-15 08:00 UTC. */
const NOW = 1_800_000_000_000;

/** A clock stopped at {@link NOW}. */
const CLOCK: UiClock = { now: () => NOW, every: () => () => undefined, after: () => () => undefined };

/** OpenAI, with a subscription and a key, signed in nowhere. */
const OPENAI: SetupProvider = {
  providerId: "openai",
  name: "OpenAI",
  oauth: { label: "ChatGPT Plus/Pro (Codex Subscription)", subscription: true },
  apiKey: true,
  signedIn: null,
};

/** First launch's checks with pi missing and Node.js ready. */
const NO_PI: SetupState = { ...READY_SETUP, pi: { ...READY_SETUP.pi, state: "missing", path: null, version: null } };

/** First launch's checks with pi ready and OpenAI signed in. */
const SIGNED_IN: SetupState = {
  ...READY_SETUP,
  login: { state: "ready", providers: [{ ...OPENAI, signedIn: { method: "oauth", stored: true } }] },
};

/** First launch's checks with pi ready, OpenAI listed, signed in nowhere. */
const SIGNED_OUT: SetupState = { ...READY_SETUP, login: { state: "ready", providers: [OPENAI] } };

/** The folders of pi's sessions, the most recent first. */
const FOUND: DiscoveredDirectory[] = [
  { path: "/work/atrium", sessions: 23, lastUsedAt: NOW - 3_600_000 },
  { path: "/work/blog", sessions: 6, lastUsedAt: NOW - 4 * 86_400_000 },
];

/**
 * Renders first launch over a fake client whose setup is `setup`.
 *
 * @remarks
 * The setup is asked for first, as the workbench does; `null` leaves it being asked. Begun on the
 * welcome page, `setupDone` is false, as it is then. The clock is stopped at {@link NOW}. With
 * `strict`, it renders in React's strict mode, as the app does, which runs effects twice.
 *
 * @sideEffects Renders.
 * @param setup - What first launch checks.
 * @param options - How it begins, how some commands answer, how a folder is chosen and a dropped
 * one read, and whether to render in strict mode.
 * @returns The screen, the fake, the addresses opened, and how often it finished.
 */
async function firstLaunch(
  setup: SetupState | null,
  options: {
    start?: FirstLaunchStart;
    answers?: Parameters<typeof fakeClient>[1];
    pickDirectory?: () => Promise<string | null>;
    pathForFile?: (file: File) => string | null;
    strict?: boolean;
  } = {},
) {
  // The size of the app's window.
  await page.viewport(1280, 820);
  const start = options.start ?? "welcome";
  const fake = fakeClient({}, { ...options.answers, ...(setup === null ? {} : { setup }) });
  if (start === "welcome")
    fake.index.setState({ preferences: { ...fake.index.getState().preferences, setupDone: false } });
  if (setup === null) fake.setup.setState({ status: "loading" });
  else await fake.client.loadSetup();
  fake.calls.length = 0;
  const opened: string[] = [];
  const finished: string[] = [];
  const shown = (
    <ClockContext value={CLOCK}>
      <div style={{ height: "820px" }}>
        <FirstLaunch
          client={fake.client}
          start={start}
          onDone={() => finished.push("done")}
          openUrl={(url) => opened.push(url)}
          pickDirectory={options.pickDirectory}
          pathForFile={options.pathForFile}
        />
      </div>
    </ClockContext>
  );
  const screen = await render(options.strict === true ? <StrictMode>{shown}</StrictMode> : shown);
  return { screen, ...fake, opened, finished };
}

/**
 * Renders first launch and goes from the welcome page to step 3.
 *
 * @remarks
 * pi is ready and OpenAI signed in, so 开始设置 skips steps 1 and 2. The discovery is answered
 * before the test looks.
 *
 * @sideEffects Renders; presses 开始设置.
 * @param options - As for {@link firstLaunch}.
 * @returns As {@link firstLaunch}.
 */
async function projectsStep(options: Parameters<typeof firstLaunch>[1] = {}) {
  const shown = await firstLaunch(SIGNED_IN, options);
  await shown.screen.getByRole("button", { name: "开始设置" }).click();
  await expect.element(shown.screen.getByRole("heading", { level: 1 })).toHaveTextContent("从一个项目开始");
  return shown;
}

/**
 * Renders the workbench over a fake client.
 *
 * @remarks
 * As the app does, with the display mode followed. The list starts as `options.initial` says,
 * as the host's first list unless `options.ready` is false.
 *
 * @sideEffects Renders; installs the display mode subscription until the test ends.
 * @param setup - What first launch checks.
 * @param options - The list to start from, whether it has arrived, and how some commands answer.
 * @returns The screen and the fake.
 */
async function workbench(
  setup: SetupState,
  options: {
    initial?: Parameters<typeof fakeClient>[0];
    ready?: boolean;
    answers?: Parameters<typeof fakeClient>[1];
  } = {},
) {
  // The size of the app's window.
  await page.viewport(1280, 820);
  const fake = fakeClient(options.initial, { ...options.answers, setup });
  fake.index.setState({ ready: options.ready ?? true });
  const screen = await render(
    <div style={{ height: "820px" }}>
      <Workbench
        client={fake.client}
        status={null}
        pickDirectory={undefined}
        setNativeAppearance={undefined}
        openUrl={() => undefined}
        reveal={undefined}
        pathForFile={undefined}
      />
    </div>,
  );
  return { screen, ...fake };
}

/**
 * An install job as the host reports it.
 *
 * @remarks
 * pi's install, job `j2`, running, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param fields - Fields to set.
 * @param output - What it wrote.
 * @returns The job.
 */
function job(fields: Partial<InstallUpdatedEvent>, output = ""): InstallJob {
  return {
    job: {
      type: "install_updated",
      jobId: "j2",
      kind: "install_pi",
      state: "running",
      running: null,
      exitCode: null,
      reason: null,
      ...fields,
    },
    output,
  };
}

/**
 * The preferences of the list, with `setupDone` as given.
 *
 * @remarks
 * For lists that start before first launch is done.
 *
 * @sideEffects none
 * @param setupDone - Whether first launch was done.
 * @returns The list's fields.
 */
function listWith(setupDone: boolean): Parameters<typeof fakeClient>[0] {
  return {
    preferences: {
      setupDone,
      appearance: "system",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    },
  };
}

describe("First launch · when it shows", () => {
  it("waits on a blank window for the host's first list, then begins on the welcome page while setup is not done", async () => {
    const { screen, index } = await workbench(READY_SETUP, { initial: listWith(false), ready: false });
    const heading = screen.getByRole("heading", { level: 1 });

    await expect.element(screen.getByRole("button", { name: "设置" })).not.toBeInTheDocument();
    await expect.element(heading).not.toBeInTheDocument();
    index.setState({ ready: true });

    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
    await expect.element(screen.getByRole("list", { name: "设置步骤" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "设置" })).not.toBeInTheDocument();
  });

  it("opens straight at step 1 once setup is done while pi cannot be used, and hands over once pi is ready", async () => {
    const { screen, setup, calls } = await workbench(NO_PI);

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先装好 pi");
    await expect.element(screen.getByRole("button", { name: "返回" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("list", { name: "设置步骤" }).getByRole("listitem").nth(0))
      .toHaveAttribute("aria-current", "step");
    setup.setState({ state: READY_SETUP });

    await expect.element(screen.getByRole("button", { name: "设置" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual(["loadSetup"]);
  });

  it("asks what first launch checks once connected, and again after reconnecting", async () => {
    const fake = fakeClient({}, { setup: NO_PI });
    fake.index.setState({ ready: false });
    fake.connection.setState({ status: "connecting", traceId: "t" }, true);
    const screen = await render(
      <Workbench
        client={fake.client}
        status={null}
        pickDirectory={undefined}
        setNativeAppearance={undefined}
        openUrl={() => undefined}
        reveal={undefined}
        pathForFile={undefined}
      />,
    );

    expect(fake.calls).toStrictEqual([]);
    fake.connection.setState(CONNECTED, true);
    fake.index.setState({ ready: true });
    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先装好 pi");
    fake.connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
    // Long enough for React to render the connection down, as a real reconnect takes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.connection.setState(CONNECTED, true);

    await expect
      .poll(() => fake.calls.filter((call) => !call.startsWith("watch")))
      .toStrictEqual(["loadSetup", "loadSetup"]);
  });

  it("shows the workbench while setup is done and pi is ready, or while the setup is not read yet", async () => {
    const { screen, setup } = await workbench(READY_SETUP);

    await expect.element(screen.getByRole("button", { name: "设置" })).toBeVisible();
    setup.setState({ status: "failed", state: null, error: new Error("x") });
    await expect.element(screen.getByRole("button", { name: "设置" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("stays until finished once shown, though another window finishes it meanwhile", async () => {
    const { screen, index } = await workbench(READY_SETUP, { initial: listWith(false) });
    const heading = screen.getByRole("heading", { level: 1 });

    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
    index.setState({ preferences: { ...index.getState().preferences, setupDone: true } });

    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
    await expect.element(screen.getByRole("button", { name: "设置" })).not.toBeInTheDocument();
  });

  it("finishes at once with nothing left to do, setting setupDone, and hands over", async () => {
    const { screen, calls, index } = await workbench({ ...SIGNED_IN, projects: 1 }, { initial: listWith(false) });

    await screen.getByRole("button", { name: "开始设置" }).click();

    await expect.element(screen.getByRole("button", { name: "设置" })).toBeVisible();
    expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual([
      "loadSetup",
      'setPreferences {"setupDone":true}',
    ]);
    expect(index.getState().preferences.setupDone).toBe(true);
  });

  it("hands over at once on finishing, before the host's list says setup is done", async () => {
    const held = Promise.withResolvers<void>();
    const { screen, index } = await workbench(
      { ...SIGNED_IN, projects: 1 },
      {
        initial: listWith(false),
        answers: { setPreferences: () => held.promise },
      },
    );

    await screen.getByRole("button", { name: "开始设置" }).click();

    await expect.element(screen.getByRole("button", { name: "设置" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(index.getState().preferences.setupDone).toBe(false);
    held.resolve();
  });
});

describe("First launch · welcome and moving between steps", () => {
  it("shows Atrium's cat in the logo slot, as decoration", async () => {
    const { screen } = await firstLaunch(SIGNED_OUT);
    const slot = () => screen.container.querySelector<HTMLImageElement>(".atrium-gmark img");

    await expect.poll(() => slot()?.naturalWidth).toBe(1024);
    const logo = slot();
    expect(logo?.getAttribute("src")).toBe(atriumLogo);
    expect(logo?.getAttribute("alt")).toBe("");
    expect(logo?.parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens pi.dev from the pill, and starts with its button, skipping steps already done", async () => {
    const { screen, opened } = await firstLaunch(SIGNED_OUT);

    await screen.getByRole("button", { name: "由 pi 驱动，开放的 agent 内核，打开 pi.dev" }).click();
    expect(opened).toStrictEqual(["https://pi.dev"]);
    await screen.getByRole("button", { name: "开始设置" }).click();

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("登录一个模型");
    const steps = screen.getByRole("list", { name: "设置步骤" }).getByRole("listitem");
    await expect.element(steps.nth(0)).toHaveTextContent("安装 pi");
    await expect.element(steps.nth(0).getByRole("img", { name: "已完成" })).toBeVisible();
    await expect.element(steps.nth(0)).not.toHaveAttribute("aria-current");
    await expect.element(steps.nth(1)).toHaveTextContent("2登录模型");
    await expect.element(steps.nth(1)).toHaveAttribute("aria-current", "step");
    await expect.element(steps.nth(2)).toHaveTextContent("3添加项目");
    await expect.element(steps.nth(2)).not.toHaveAttribute("aria-current");
  });

  it("presses the main button on Enter, but not with a modifier, on another button, or while it is disabled", async () => {
    const { screen, opened } = await firstLaunch(SIGNED_OUT);
    const heading = screen.getByRole("heading", { level: 1 });

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
    screen.getByRole("button", { name: "由 pi 驱动，开放的 agent 内核，打开 pi.dev" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
    expect(opened).toStrictEqual(["https://pi.dev"]);

    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Enter}");
    await expect.element(heading).toHaveTextContent("登录一个模型");
    await userEvent.keyboard("{Enter}");
    await expect.element(heading).toHaveTextContent("登录一个模型");
  });

  it("goes back through every step to the welcome page, step 1 then showing pi ready", async () => {
    const { screen } = await projectsStep();
    const heading = screen.getByRole("heading", { level: 1 });

    await screen.getByRole("button", { name: "返回" }).click();
    await expect.element(heading).toHaveTextContent("登录一个模型");
    await screen.getByRole("button", { name: "返回" }).click();
    await expect.element(heading).toHaveTextContent("pi 已就绪");
    await expect.element(screen.getByText("找到了 pi，终端里也能直接用。")).toBeVisible();
    await expect.element(screen.getByText("pi 0.80.0")).toBeVisible();
    await expect.element(screen.getByText("/opt/homebrew/bin/pi")).toBeVisible();

    await screen.getByRole("button", { name: "继续" }).click();
    await expect.element(heading).toHaveTextContent("从一个项目开始");
    await screen.getByRole("button", { name: "返回" }).click();
    await screen.getByRole("button", { name: "返回" }).click();
    await screen.getByRole("button", { name: "返回" }).click();
    await expect.element(heading).toHaveTextContent("看得见内部的coding agent");
  });

  it("goes on by itself once pi turns ready, to the first step not done", async () => {
    const { screen, setup, installJob, calls } = await firstLaunch(NO_PI);
    const heading = screen.getByRole("heading", { level: 1 });

    await screen.getByRole("button", { name: "开始设置" }).click();
    await expect.element(heading).toHaveTextContent("先装好 pi");
    await screen.getByRole("button", { name: "安装 pi" }).click();
    installJob.setState(job({ state: "ok", exitCode: 0 }), true);
    setup.setState({ state: SIGNED_IN });

    await expect.element(heading).toHaveTextContent("从一个项目开始");
    expect(calls).toStrictEqual(["installPi", "discoverProjects"]);
  });

  it("begun because pi cannot be used, finishes once pi is ready, without setting setupDone again", async () => {
    const { screen, setup, calls, finished } = await firstLaunch(NO_PI, { start: "install" });

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先装好 pi");
    setup.setState({ state: SIGNED_OUT });

    await expect.poll(() => finished).toStrictEqual(["done"]);
    expect(calls).toStrictEqual([]);
  });
});

/**
 * Whether anything is drawn on a canvas.
 *
 * @remarks
 * For the start button's band, which clears its canvas between sweeps.
 *
 * @sideEffects none
 * @param canvas - The canvas.
 * @returns Whether some pixel is not transparent.
 */
function inked(canvas: HTMLCanvasElement): boolean {
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
  for (let index = 3; index < pixels.length; index += 4) if ((pixels[index] ?? 0) > 0) return true;
  return false;
}

/**
 * The canvas inside an element.
 *
 * @remarks
 * The start button draws its band on one.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns The canvas.
 * @throws {Error} When there is none.
 */
function canvasIn(element: Element): HTMLCanvasElement {
  const canvas = element.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  return canvas;
}

/**
 * A folder picker that answers `paths` in turn, then nothing.
 *
 * @remarks
 * As the user choosing one folder each time.
 *
 * @sideEffects none until called; then takes the next path.
 * @param paths - The folders, in order.
 * @returns The picker.
 */
function picker(paths: readonly string[]): () => Promise<string | null> {
  const left = [...paths];
  return async () => left.shift() ?? null;
}

/**
 * A dropped file's path, as the desktop bridge reads it: under `/work`, none for `notes.txt`.
 *
 * @remarks
 * The bridge answers an empty path for what it cannot read.
 *
 * @sideEffects none
 * @param file - The file.
 * @returns Its path.
 */
function workPath(file: File): string {
  return file.name === "notes.txt" ? "" : `/work/${file.name}`;
}

/**
 * An `add_project` answer that fails the `number`th time, counting from 1.
 *
 * @remarks
 * A plain error by default, which the step words as a generic failure.
 *
 * @sideEffects none until called; then counts the calls.
 * @param number - Which call fails.
 * @param error - What it fails with.
 * @returns The answer.
 */
function failingAt(number: number, error: Error = new Error("gone")): () => Promise<void> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === number) throw error;
  };
}

describe("First launch · the start button's band", () => {
  it("sweeps once soon after showing, asks no frames until the next, sweeps at once on hover, and stops once gone", async () => {
    const { screen } = await firstLaunch(SIGNED_OUT);
    const button = screen.getByRole("button", { name: "开始设置" });
    const canvas = canvasIn(button.element());
    const frames = vi.spyOn(window, "requestAnimationFrame");
    onTestFinished(() => frames.mockRestore());

    await expect.poll(() => inked(canvas), { timeout: 1_500 }).toBe(true);
    await expect.poll(() => inked(canvas), { timeout: 2_000 }).toBe(false);
    // The band leaves the button before its sweep is over; the sweep ends within 1.1 s of starting.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const idle = frames.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frames.mock.calls.length).toBe(idle);
    await button.hover();
    await expect.poll(() => inked(canvas), { timeout: 800 }).toBe(true);

    await screen.unmount();
    const asked = frames.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames.mock.calls.length).toBe(asked);
  });
});

describe("First launch · step 1", () => {
  it("installs pi with its output live, cancellable", async () => {
    const { screen, installJob, calls } = await firstLaunch(NO_PI, { start: "install" });

    await expect.element(screen.getByText("Atrium 用 pi 作为 agent 内核，这台电脑上还没有找到它。")).toBeVisible();
    await expect
      .element(screen.getByRole("log", { name: "安装 pi" }))
      .toHaveTextContent("安装 pi# 点“安装 pi”后，这里显示实时输出$ curl -fsSL https://pi.dev/install.sh | sh");
    await expect.element(screen.getByText("也可以复制命令，在终端里自己装")).toBeVisible();
    await screen.getByRole("button", { name: "安装 pi" }).click();

    installJob.setState(job({ state: "waiting", running: 2 }), true);
    await expect.element(screen.getByText("等待 2 个会话运行结束，结束后自动开始")).toBeVisible();
    installJob.setState(job({}, "Downloading pi\nInstalled 1 package\n"), true);
    await expect
      .element(screen.getByRole("log", { name: "安装 pi" }))
      .toHaveTextContent("安装 piDownloading piInstalled 1 package");
    await expect.element(screen.getByText("正在运行，可以随时取消")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "正在安装" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "我已经装好了" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "取消" }).click();

    installJob.setState(job({ state: "cancelled" }), true);
    await expect.element(screen.getByRole("button", { name: "安装 pi" })).toBeEnabled();
    expect(calls).toStrictEqual(["installPi", "cancelInstall j2"]);
  });

  it("offers the install script or npm to copy", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const { screen } = await firstLaunch(NO_PI, { start: "install" });

    await expect.element(screen.getByRole("button", { name: "安装脚本" })).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "npm" }).click();
    await expect.element(screen.getByRole("button", { name: "npm" })).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByRole("button", { name: "安装脚本" })).toHaveAttribute("aria-pressed", "false");
    await expect
      .element(screen.getByRole("log", { name: "安装 pi" }))
      .toHaveTextContent(
        "安装 pi# 点“安装 pi”后，这里显示实时输出$ npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
      );
    await screen
      .getByRole("button", { name: "复制 npm install -g --ignore-scripts @earendil-works/pi-coding-agent" })
      .click();

    await expect.element(screen.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(written).toStrictEqual(["npm install -g --ignore-scripts @earendil-works/pi-coding-agent"]);
  });

  it("says why an install failed, with its output and 重试", async () => {
    const { screen, installJob, calls } = await firstLaunch(NO_PI, { start: "install" });
    const heading = screen.getByRole("heading", { level: 1 });
    const rest = "可以重试，或者复制命令在终端里自己装。";

    installJob.setState(
      job({ state: "failed", exitCode: 1, reason: "exit" }, "curl: (6) Could not resolve host\n"),
      true,
    );
    await expect.element(heading).toHaveTextContent("没有装好");
    await expect.element(screen.getByText(`安装脚本 退出码 1，完整日志在下面。${rest}`)).toBeVisible();
    await expect
      .element(screen.getByRole("log", { name: "安装 pi" }))
      .toHaveTextContent("安装 picurl: (6) Could not resolve host");
    await expect.element(screen.getByText("没有装好。可以重试，或复制命令自己装")).toBeVisible();
    installJob.setState(job({ state: "failed", exitCode: null, reason: "exit" }), true);
    await expect.element(screen.getByText(`安装脚本 被中途结束了，完整日志在下面。${rest}`)).toBeVisible();
    installJob.setState(job({ state: "failed", exitCode: null, reason: "spawn_failed" }), true);
    await expect.element(screen.getByText(`启动不了 安装脚本。${rest}`)).toBeVisible();
    installJob.setState(job({ state: "failed", exitCode: null, reason: "download_failed" }), true);
    await expect.element(screen.getByText(`下载不了安装脚本，多半是网络问题。${rest}`)).toBeVisible();
    await screen.getByRole("button", { name: "重试" }).click();

    expect(calls).toStrictEqual(["installPi"]);
  });

  it("says why an install was refused", async () => {
    const answers = { installPi: () => Promise.reject(new CommandError("install_busy")) };
    const { screen } = await firstLaunch(NO_PI, { start: "install", answers });

    await screen.getByRole("button", { name: "安装 pi" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("另一个安装任务正在进行，等它结束再试");
  });

  it("checks again with the login shell read again, saying when pi is still not there", async () => {
    const { screen, calls } = await firstLaunch(NO_PI, { start: "install" });

    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "我已经装好了" }).click();

    await expect.element(screen.getByRole("status")).toHaveTextContent("还是没找到，可能要重开终端");
    expect(calls).toStrictEqual(["loadSetup refresh"]);
  });

  it("says when a finished install still left no pi, and checks again", async () => {
    const { screen, installJob, calls } = await firstLaunch(NO_PI, { start: "install" });

    installJob.setState(job({ state: "ok", exitCode: 0 }), true);
    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("装好了");
    await expect.element(screen.getByText("跑完了，但还是找不到能用的 pi，可能要重开终端。")).toBeVisible();
    await expect.element(screen.getByText("完成")).toBeVisible();
    await screen.getByRole("button", { name: "重新检测" }).click();

    await expect.element(screen.getByRole("status")).toHaveTextContent("还是没找到，可能要重开终端");
    expect(calls).toStrictEqual(["loadSetup refresh"]);
  });

  it("updates a pi too old, saying when it is still old", async () => {
    const outdated = { ...READY_SETUP, pi: { ...READY_SETUP.pi, state: "outdated" as const, version: "0.70.0" } };
    const { screen, installJob, calls } = await firstLaunch(outdated, { start: "install" });

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("pi 需要更新");
    await expect.element(screen.getByText("第 1 步 · 更新 pi")).toBeVisible();
    await expect.element(screen.getByText("找到的 pi 是 0.70.0，Atrium 需要 0.74.0 或更高的版本。")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "npm" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "复制 pi update" })).toBeVisible();
    await screen.getByRole("button", { name: "我已经更新了" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("还是旧版本，可能要重开终端");
    await screen.getByRole("button", { name: "更新 pi" }).click();

    installJob.setState(job({ jobId: "j1", kind: "update_pi" }), true);
    await expect.element(screen.getByRole("button", { name: "正在更新" })).toBeDisabled();
    installJob.setState(job({ jobId: "j1", kind: "update_pi", state: "ok", exitCode: 0 }), true);
    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("更新好了");
    expect(calls).toStrictEqual(["loadSetup refresh", "updatePi"]);
  });

  it("installs Node.js with Homebrew first, then pi by itself, once", async () => {
    const noNode = { ...NO_PI, node: { state: "missing" as const, version: null } };
    const { screen, installJob, calls, opened } = await firstLaunch(noNode, { start: "install", strict: true });

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("还需要 Node.js");
    await expect.element(screen.getByText("Node.js 22.19+ 未找到")).toBeVisible();
    await expect.element(screen.getByText("Homebrew 已安装")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "复制 brew install node" })).toBeVisible();
    await screen.getByRole("button", { name: "去 nodejs.org 下载" }).click();
    expect(opened).toStrictEqual(["https://nodejs.org/"]);
    await screen.getByRole("button", { name: "用 Homebrew 安装" }).click();

    installJob.setState(job({ jobId: "j3", kind: "install_node" }), true);
    await expect.element(screen.getByRole("log", { name: "安装 Node.js" })).toBeVisible();
    installJob.setState(job({ jobId: "j3", kind: "install_node", state: "ok", exitCode: 0 }), true);

    await expect.poll(() => calls).toStrictEqual(["installNode", "installPi"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toStrictEqual(["installNode", "installPi"]);

    // Before the checks find the new Node.js, pi's install shows here all the same.
    installJob.setState(job({ jobId: "j4" }, "installing pi\n"), true);
    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先装好 pi");
    await expect.element(screen.getByRole("log", { name: "安装 pi" })).toHaveTextContent("安装 piinstalling pi");
    await expect.element(screen.getByRole("button", { name: "正在安装" })).toBeDisabled();
    installJob.setState(job({ jobId: "j4", state: "failed", exitCode: 1, reason: "exit" }, "installing pi\n"), true);
    await screen.getByRole("button", { name: "重试" }).click();
    expect(calls).toStrictEqual(["installNode", "installPi", "installPi"]);
  });

  it("does not install pi after a Node.js install it did not start", async () => {
    const noNode = { ...NO_PI, node: { state: "outdated" as const, version: "20.1.0" } };
    const { screen, installJob, calls } = await firstLaunch(noNode, { start: "install" });

    await expect.element(screen.getByText("Node.js 20.1.0 太旧，需要 22.19+")).toBeVisible();
    await screen.getByRole("button", { name: "用 Homebrew 安装" }).click();
    installJob.setState(job({ jobId: "j9", kind: "install_node", state: "ok", exitCode: 0 }), true);

    await expect.element(screen.getByText("跑完了，但还是找不到能用的 Node.js，可能要重开终端。")).toBeVisible();
    expect(calls).toStrictEqual(["installNode"]);
  });

  it("sends to nodejs.org without Homebrew, and checks again", async () => {
    const noBrew = { ...NO_PI, node: { state: "missing" as const, version: null }, homebrew: false };
    const { screen, calls, opened } = await firstLaunch(noBrew, { start: "install" });

    await expect.element(screen.getByText("没有 Homebrew")).toBeVisible();
    await expect.element(screen.getByText("pi 运行在 Node.js 上，先从 nodejs.org 下载安装。")).toBeVisible();
    await screen.getByRole("button", { name: "去 nodejs.org 下载" }).click();
    expect(opened).toStrictEqual(["https://nodejs.org/"]);
    await screen.getByRole("button", { name: "我已经装好了" }).click();

    await expect.element(screen.getByRole("status")).toHaveTextContent("还是没找到，可能要重开终端");
    expect(calls).toStrictEqual(["loadSetup refresh"]);
  });

  it("offers to reinstall a broken pi, its own error under a disclosure", async () => {
    const broken = { ...NO_PI, pi: { ...NO_PI.pi, state: "broken" as const, detail: "SyntaxError: Unexpected token" } };
    const { screen, calls } = await firstLaunch(broken, { start: "install" });
    const disclosure = screen.getByRole("button", { name: "展开看原始报错" });

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("pi 运行不了");
    await expect.element(screen.getByText("找到的 pi 启动不了，重新安装一次通常能修好。")).toBeVisible();
    await expect.element(screen.getByText("SyntaxError: Unexpected token")).not.toBeInTheDocument();
    await disclosure.click();
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("SyntaxError: Unexpected token")).toBeVisible();
    await screen.getByRole("button", { name: "安装 pi" }).click();

    expect(calls).toStrictEqual(["installPi"]);
  });

  it("waits while pi is being checked, and offers to check again when that failed", async () => {
    const { screen, setup, calls } = await firstLaunch(null, { start: "install" });

    await expect.element(screen.getByText("正在检查这台电脑上的 pi…")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "正在检查" })).toBeDisabled();
    setup.setState({ status: "failed", error: new Error("x") });
    await expect.element(screen.getByText("没能检查这台电脑上的 pi，再试一次。")).toBeVisible();
    await screen.getByRole("button", { name: "重新检测" }).click();

    expect(calls).toStrictEqual(["loadSetup refresh"]);
  });
});

describe("First launch · step 2", () => {
  it("logs in with a subscription or a key, 继续 waiting for a credential", async () => {
    const { screen, setup } = await firstLaunch(SIGNED_OUT);
    const next = screen.getByRole("button", { name: "继续" });

    await screen.getByRole("button", { name: "开始设置" }).click();
    await expect.element(screen.getByRole("radio", { name: "用订阅登录" })).toHaveAttribute("aria-checked", "true");
    await expect.element(screen.getByRole("button", { name: "登录 ChatGPT" })).toBeVisible();
    await expect.element(screen.getByText("点“登录”会打开浏览器，在官网完成授权后自动回到这里")).toBeVisible();
    await expect.element(next).toBeDisabled();
    await screen.getByRole("radio", { name: "使用 API Key" }).click();
    await expect.element(screen.getByRole("radio", { name: "使用 API Key" })).toHaveAttribute("aria-checked", "true");
    await expect.element(screen.getByRole("textbox", { name: "API Key" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "登录 ChatGPT" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Key 写在 ~/.pi/agent/auth.json，只保存在这台电脑上")).toBeVisible();

    setup.setState({ state: SIGNED_IN });
    await next.click();
    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("从一个项目开始");
  });

  it("sends to the terminal's /login when Atrium cannot log in through pi, and lets it go on", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const unavailable: SetupState = { ...READY_SETUP, login: { state: "unavailable" } };
    const { screen, calls } = await firstLaunch(unavailable);

    await screen.getByRole("button", { name: "开始设置" }).click();
    await expect.element(screen.getByText("Atrium 加载不了你装的 pi，没法在这里登录。")).toBeVisible();
    await expect.element(screen.getByRole("radiogroup", { name: "登录方式" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "复制 pi" }).click();
    expect(written).toStrictEqual(["pi"]);
    await screen.getByRole("button", { name: "我登录好了，重新检测" }).click();
    expect(calls).toStrictEqual(["loadSetup"]);
    await screen.getByRole("button", { name: "继续" }).click();

    await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent("从一个项目开始");
  });
});

describe("First launch · step 3", () => {
  it("offers the folders of pi's sessions, the most recent ticked, and adds those ticked", async () => {
    const { screen, calls, finished } = await projectsStep({ answers: { discover: async () => FOUND } });
    const folders = screen.getByRole("group", { name: "要添加的文件夹" });

    await expect.element(folders.getByText("在 pi 的历史会话里找到")).toBeVisible();
    await expect
      .element(folders.getByRole("checkbox", { name: "atrium" }))
      .toHaveTextContent("atrium/work/atrium23 个会话 · 1 小时前");
    await expect.element(folders.getByRole("checkbox", { name: "atrium" })).toHaveAttribute("aria-checked", "true");
    await expect
      .element(folders.getByRole("checkbox", { name: "blog" }))
      .toHaveTextContent("blog/work/blog6 个会话 · 1月11日");
    await expect.element(folders.getByRole("checkbox", { name: "blog" })).toHaveAttribute("aria-checked", "false");
    await expect.element(screen.getByRole("button", { name: "添加 1 个项目" })).toBeVisible();
    await folders.getByRole("checkbox", { name: "blog" }).click();
    await folders.getByRole("checkbox", { name: "atrium" }).click();
    await folders.getByRole("checkbox", { name: "atrium" }).click();
    await screen.getByRole("button", { name: "添加 2 个项目" }).click();

    await expect.poll(() => finished).toStrictEqual(["done"]);
    expect(calls).toStrictEqual([
      "discoverProjects",
      "addProject /work/atrium",
      "addProject /work/blog",
      'setPreferences {"setupDone":true}',
    ]);
  });

  it("puts a folder chosen on top, ticked, and only ticks one listed already", async () => {
    const { screen } = await projectsStep({
      answers: { discover: async () => FOUND },
      pickDirectory: picker(["/work/new", "/work/blog"]),
    });
    const folders = screen.getByRole("group", { name: "要添加的文件夹" }).getByRole("checkbox");

    await expect.element(folders.nth(1)).toBeVisible();
    await screen.getByRole("button", { name: "把项目文件夹拖到这里 或者点击选择" }).click();
    await expect.element(folders.nth(0)).toHaveTextContent("new/work/new刚选的");
    await expect.element(folders.nth(0)).toHaveAttribute("aria-checked", "true");
    await screen.getByRole("button", { name: "把项目文件夹拖到这里 或者点击选择" }).click();

    await expect.element(screen.getByRole("button", { name: "添加 3 个项目" })).toBeVisible();
    expect(folders.elements().map((one) => one.getAttribute("aria-label"))).toStrictEqual(["new", "atrium", "blog"]);
  });

  it("offers folders dropped on the zone, ticked", async () => {
    const { screen } = await projectsStep({
      pickDirectory: async () => null,
      pathForFile: workPath,
    });
    const zone = screen.getByRole("button", { name: "把项目文件夹拖到这里 或者点击选择" });

    await expect.element(screen.getByRole("group", { name: "要添加的文件夹" })).not.toBeInTheDocument();
    const files = new DataTransfer();
    files.items.add(new File([], "api"));
    files.items.add(new File([], "notes.txt"));
    files.items.add(new File([], "web"));
    zone.element().dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: files }));
    await expect.element(zone).toHaveAttribute("data-over", "");
    zone.element().dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: files }));

    await expect.element(zone).not.toHaveAttribute("data-over");
    const folders = screen.getByRole("group", { name: "要添加的文件夹" });
    await expect.element(folders.getByRole("checkbox", { name: "api" })).toHaveAttribute("aria-checked", "true");
    await expect.element(folders.getByRole("checkbox", { name: "web" })).toHaveAttribute("aria-checked", "true");
    expect(folders.getByRole("checkbox").elements()).toHaveLength(2);
    await expect.element(folders.getByText("在 pi 的历史会话里找到")).not.toBeInTheDocument();
  });

  it("keeps the folders that failed to add with the first reason, and drops those added", async () => {
    const answers = {
      discover: async () => FOUND,
      addProject: async () => {
        throw new CommandError("path_not_found");
      },
    };
    const { screen, calls, finished } = await projectsStep({ answers });
    const folders = screen.getByRole("group", { name: "要添加的文件夹" });

    await folders.getByRole("checkbox", { name: "blog" }).click();
    await screen.getByRole("button", { name: "添加 2 个项目" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("atrium：这个目录不存在");
    expect(folders.getByRole("checkbox").elements()).toHaveLength(2);
    await expect.element(screen.getByRole("button", { name: "添加 2 个项目" })).toBeEnabled();
    expect(finished).toStrictEqual([]);
    expect(calls).toStrictEqual(["discoverProjects", "addProject /work/atrium", "addProject /work/blog"]);
  });

  it("drops a folder added though another failed", async () => {
    const answers = { discover: async () => FOUND, addProject: failingAt(2) };
    const { screen, finished } = await projectsStep({ answers });
    const folders = screen.getByRole("group", { name: "要添加的文件夹" });

    await folders.getByRole("checkbox", { name: "blog" }).click();
    await screen.getByRole("button", { name: "添加 2 个项目" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("blog：添加项目失败");
    expect(
      folders
        .getByRole("checkbox")
        .elements()
        .map((one) => one.getAttribute("aria-label")),
    ).toStrictEqual(["blog"]);
    expect(finished).toStrictEqual([]);
  });

  it("counts a folder already in a project as added, finishing when the rest are in", async () => {
    const answers = {
      discover: async () => FOUND,
      addProject: failingAt(2, new CommandError("project_exists", { projectId: "p1" })),
    };
    const { screen, calls, finished } = await projectsStep({ answers });
    const folders = screen.getByRole("group", { name: "要添加的文件夹" });

    await folders.getByRole("checkbox", { name: "blog" }).click();
    await screen.getByRole("button", { name: "添加 2 个项目" }).click();

    await expect.poll(() => finished).toStrictEqual(["done"]);
    expect(screen.getByRole("alert").elements()).toStrictEqual([]);
    expect(calls).toStrictEqual([
      "discoverProjects",
      "addProject /work/atrium",
      "addProject /work/blog",
      'setPreferences {"setupDone":true}',
    ]);
  });

  it("waits for something ticked, and starts a chat instead with 先新建一个对话", async () => {
    const { screen, calls, finished } = await projectsStep();

    await expect.element(screen.getByRole("button", { name: "把项目文件夹拖到这里 或者点击选择" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "添加项目" })).toBeDisabled();
    await screen.getByRole("button", { name: "先新建一个对话" }).click();

    await expect
      .poll(() => calls)
      .toStrictEqual(["discoverProjects", "createChat", 'setPreferences {"setupDone":true}']);
    expect(finished).toStrictEqual(["done"]);
  });
});

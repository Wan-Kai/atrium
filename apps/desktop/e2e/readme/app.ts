import {
  README_FAUX_EXTENSION,
  README_FAUX_GATES_ENV,
  README_FAUX_LOG_ENV,
  README_FAUX_SCRIPT_ENV,
  type ReadmeFauxScript,
} from "@atrium/testkit";
import { type ElectronApplication, type Page, _electron as electron, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realPi } from "../faux-pi";
import { addProject } from "../projects";

/** A loopback stand-in for ChatGPT's backend. */
interface Backend {
  /** The address the `openai-codex` provider's requests go to. */
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Starts a loopback stand-in for ChatGPT's backend: Codex's model list and the plan's usage.
 *
 * @remarks
 * Atrium asks ChatGPT for which models are Fast and how much of the plan is used; the model panel
 * in the screenshots shows both, and the tool must not reach the network. Reset times are counted
 * from each request, so the panel shows the same hours on every run.
 *
 * @sideEffects Listens on a free loopback port.
 * @returns The backend.
 */
export async function startBackend(): Promise<Backend> {
  const HOUR = 3_600_000;
  const models = {
    models: [
      {
        slug: "gpt-6.1-sol",
        visibility: "list",
        service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
      },
      {
        slug: "gpt-6-sol",
        visibility: "list",
        service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      },
      { slug: "gpt-5.5", visibility: "list", service_tiers: [] },
    ],
  };
  const server: Server = createServer((request, response) => {
    const usage = {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 18,
          limit_window_seconds: 18_000,
          reset_at: Math.floor((Date.now() + 3 * HOUR + 12 * 60_000) / 1000),
        },
        secondary_window: {
          used_percent: 35,
          limit_window_seconds: 604_800,
          reset_at: Math.floor((Date.now() + 5 * 24 * HOUR) / 1000),
        },
      },
    };
    const body = request.url?.startsWith("/backend-api/wham/usage") === true ? usage : models;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the backend has no port");
  const { port }: AddressInfo = address;
  return {
    baseUrl: `http://127.0.0.1:${port}/backend-api`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The app launched for the screenshots. */
interface ShotsApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** Lets the replies scripted with `waitFor: name` continue. */
  readonly release: (name: string) => void;
}

/**
 * Launches the built app on fresh homes inside `run`, with pi answering from the README script.
 *
 * @remarks
 * The environment is built from nothing rather than from this process's, so the screenshots never
 * show the user's projects, settings, models or git identity: Atrium's home, pi's agent directory
 * and `HOME` are new directories, `PI_OFFLINE` keeps pi off the network and `SHELL` makes the
 * host use this environment instead of the login shell's (SPEC-0001, "第 1 步"). A `pi` wrapper
 * first on PATH runs the installed pi with the README extension, as `fauxPiEnvironment` does for
 * the tests. The window gets the content size that, captured on a Retina screen, gives the
 * README's 1920 × 1145 after scaling.
 *
 * @sideEffects Creates directories and files under `run`; launches Electron; resizes and centres
 * its window.
 * @param run - The run's temporary directory.
 * @param script - What pi answers.
 * @param appearance - The appearance Atrium starts with.
 * @returns The app, its window and the gate release.
 */
export async function launchShotsApp(
  run: string,
  script: ReadmeFauxScript,
  appearance: "light" | "dark" | "system",
): Promise<ShotsApp> {
  const home = join(run, "atrium-home");
  const piDir = join(run, "pi");
  const fakeHome = join(run, "home");
  const agentDir = join(piDir, "agent");
  const gates = join(piDir, "gates");
  const bin = join(piDir, "bin");
  for (const dir of [home, fakeHome, agentDir, gates, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(piDir, "script.json"), JSON.stringify(script));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "claude-bridge", defaultModel: "claude-opus-5-5", defaultThinkingLevel: "high" }),
  );
  writeFileSync(
    join(home, "preferences.json"),
    `${JSON.stringify({
      version: 3,
      appearance,
      lastModel: { providerId: "claude-bridge", modelId: "claude-opus-5-5" },
      thinkingByModel: { "claude-bridge/claude-opus-5-5": "high", "openai-codex/gpt-6.1-sol": "high" },
      setupDone: true,
    })}\n`,
  );
  const pi = await realPi();
  const wrapper = join(bin, "pi");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "${pi}" --version; fi\nexec "${pi}" "$@" --extension '${README_FAUX_EXTENSION}'\n`,
  );
  chmodSync(wrapper, 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    HOME: fakeHome,
    TMPDIR: tmpdir(),
    LANG: "zh_CN.UTF-8",
    SHELL: "/usr/bin/false",
    ATRIUM_HOME: home,
    ATRIUM_PI_LATEST_URL: "",
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    [README_FAUX_SCRIPT_ENV]: join(piDir, "script.json"),
    [README_FAUX_GATES_ENV]: gates,
    [README_FAUX_LOG_ENV]: join(piDir, "faux.log"),
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const app = await electron.launch({ args: ["."], cwd: join(import.meta.dirname, "../.."), env, colorScheme: null });
  const window = await app.firstWindow();
  await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 20_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (win === undefined) throw new Error("the app has no window");
    win.setContentSize(1440, 859);
    win.center();
  });
  return { app, window, release: (name) => writeFileSync(join(gates, name), "") };
}

/**
 * Adds the demo project through the sidebar and waits for its workspaces.
 *
 * @remarks
 * The story starts on the project's workspaces, which appear once the host has scanned its
 * worktrees.
 *
 * @sideEffects Replaces the app's folder dialog; clicks "添加项目".
 * @param app - The app.
 * @param window - Its window.
 * @param repo - The demo project's folder.
 */
export async function addDemo(app: ElectronApplication, window: Page, repo: string): Promise<void> {
  await addProject(app, window, repo);
  await expect(window.getByTestId("workspace-row").first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Captures the window as macOS draws it, rounded corners and traffic lights, 1920 × 1145.
 *
 * @remarks
 * A page screenshot would miss the window's frame, which the README shows. `screencapture -l`
 * takes one window by its id, which Electron's media source id carries; `-o` leaves out the
 * shadow and `-x` the sound. `sips` scales the Retina capture to the README's size.
 *
 * @sideEffects Focuses the window, which may bring it to the front; writes `raw.png` in `run` and
 * the image to `file`.
 * @param app - The app.
 * @param run - The run's temporary directory.
 * @param file - Where the image goes.
 */
export async function capture(app: ElectronApplication, run: string, file: string): Promise<void> {
  const id = await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (win === undefined) throw new Error("the app has no window");
    win.focus();
    return win.getMediaSourceId();
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const windowId = id.split(":")[1];
  if (windowId === undefined) throw new Error(`unexpected media source id ${id}`);
  const raw = join(run, "raw.png");
  execFileSync("screencapture", ["-o", "-x", `-l${windowId}`, raw]);
  execFileSync("sips", ["-z", "1145", "1920", raw, "--out", file], { stdio: "ignore" });
}

import type { InstallJob } from "@atrium/client";
import { CommandError, type InstallUpdatedEvent, type SetupPi } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { READY_SETUP, fakeClient } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/** The time the tests run at. */
const NOW = 1_800_000_000_000;

/** The block offering pi 0.81.0 over 0.80.0. */
const OFFERED = "有新版本 0.81.0当前 0.80.0。更新的是你装的这个 pi，终端里的 pi 也会一起更新更新 pi";

/** A clock stopped at {@link NOW}. */
const CLOCK: UiClock = { now: () => NOW, every: () => () => undefined };

/**
 * Renders the settings on the pi part, over a fake client that knows `pi`.
 *
 * @remarks
 * Through the panel, as the user reaches it; the setup is asked for first, as the workbench does.
 *
 * @sideEffects Renders.
 * @param pi - pi's fields that differ from a ready, up-to-date one.
 * @param options - How some commands answer, and whether the Finder can be reached.
 * @returns The screen, the fake, and the paths shown in the Finder.
 */
async function piSection(
  pi: Partial<SetupPi> = {},
  options: { answers?: Parameters<typeof fakeClient>[1]; finder?: boolean } = {},
) {
  // The size of the app's window, which the settings sit in.
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { ...options.answers, setup: { ...READY_SETUP, pi: { ...READY_SETUP.pi, ...pi } } });
  await fake.client.loadSetup();
  fake.calls.length = 0;
  const revealed: string[] = [];
  const screen = await render(
    <ClockContext value={CLOCK}>
      <SettingsPanel
        client={fake.client}
        section="pi"
        onSection={() => undefined}
        onClose={() => undefined}
        openUrl={() => undefined}
        reveal={options.finder === false ? undefined : (path) => revealed.push(path)}
      />
    </ClockContext>,
  );
  return { screen, ...fake, revealed };
}

/**
 * An install job as the host reports it.
 *
 * @remarks
 * `pi update`, job `j1`, running, unless `fields` say otherwise.
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
      jobId: "j1",
      kind: "update_pi",
      state: "running",
      running: null,
      exitCode: null,
      reason: null,
      ...fields,
    },
    output,
  };
}

describe("Settings · pi", () => {
  it("shows where pi is, its version, the latest and when it was looked for, and shows pi in the Finder", async () => {
    const { screen, revealed } = await piSection({ checkedAt: NOW - 2 * 60 * 60 * 1000 });

    await expect.element(screen.getByText("/opt/homebrew/bin/pi")).toBeVisible();
    const rows = screen.getByRole("dialog").getByText(/^(当前版本|最新版本|上次检查)$/);
    expect(rows.elements().map((row) => row.parentElement?.parentElement?.textContent)).toStrictEqual([
      "当前版本0.80.0",
      "最新版本0.80.0已是最新",
      "上次检查2 小时前检查更新",
    ]);
    await expect.element(screen.getByRole("status")).toHaveTextContent("pi 已是最新版本有新版本时这里会出现“更新 pi”");
    await screen.getByRole("button", { name: "在访达中显示" }).click();
    expect(revealed).toStrictEqual(["/opt/homebrew/bin/pi"]);
  });

  it("offers no Finder outside the desktop app, and says what is not known yet", async () => {
    const { screen } = await piSection({ latest: null, checkedAt: null }, { finder: false });

    await expect.element(screen.getByText("/opt/homebrew/bin/pi")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "在访达中显示" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("还没查过")).toBeVisible();
    await expect.element(screen.getByText("已是最新")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("status")).toHaveTextContent("还不知道最新版本有新版本时这里会出现“更新 pi”");
  });

  it("looks for the latest pi when asked, the button busy meanwhile", async () => {
    const gate = Promise.withResolvers<void>();
    const { screen, calls } = await piSection({}, { answers: { checkPiUpdate: () => gate.promise } });

    await screen.getByRole("button", { name: "检查更新" }).click();
    await expect.element(screen.getByRole("button", { name: "正在检查" })).toBeDisabled();
    gate.resolve();
    await expect.element(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
    expect(calls).toStrictEqual(["checkPiUpdate"]);
  });

  it("offers a newer pi and updates it: waiting for sessions, its output while running, and the version reached", async () => {
    const { screen, calls, installJob, setup } = await piSection({ latest: "0.81.0" });
    const block = screen.getByRole("status");

    await expect.element(block).toHaveTextContent(OFFERED);
    await expect.element(screen.getByText("已是最新")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "更新 pi" }).click();

    installJob.setState(job({ state: "waiting", running: 2 }), true);
    await expect.element(block).toHaveTextContent("等待 2 个会话运行结束结束后自动开始更新取消");
    await expect.element(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();

    installJob.setState(job({}, "\u001b[32mfetching\u001b[0m pi\nadded 1 package\n"), true);
    await expect
      .element(screen.getByRole("log", { name: "更新 pi" }))
      .toHaveTextContent("更新 pifetching piadded 1 package");
    await expect
      .element(block)
      .toHaveTextContent("正在更新到 0.81.0新开的会话会等更新完成再启动 pi取消更新 pifetching piadded 1 package");
    await expect.element(screen.getByRole("button", { name: "手动更新" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "取消" }).click();

    setup.setState({ state: { ...READY_SETUP, pi: { ...READY_SETUP.pi, version: "0.81.0", latest: "0.81.0" } } });
    installJob.setState(job({ state: "ok", exitCode: 0 }, "added 1 package\n"), true);
    await expect.element(block).toHaveTextContent("已更新到 0.81.0空闲会话的 pi 在下次使用时用新版本重启查看日志");
    await expect.element(screen.getByRole("log")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "查看日志" }).click();
    await expect.element(screen.getByRole("log", { name: "更新 pi" })).toHaveTextContent("更新 piadded 1 package");
    await screen.getByRole("button", { name: "收起日志" }).click();
    await expect.element(screen.getByRole("log")).not.toBeInTheDocument();
    expect(calls).toStrictEqual(["updatePi", "cancelInstall j1"]);
  });

  it("keeps a running update's latest output in view", async () => {
    const { screen, installJob } = await piSection({ latest: "0.81.0" });
    const lines = Array.from({ length: 40 }, (_, at) => `line ${at + 1}\n`);

    installJob.setState(job({}, lines.slice(0, 20).join("")), true);
    await expect.element(screen.getByText("line 20")).toBeInTheDocument();
    installJob.setState(job({}, lines.join("")), true);
    await expect.element(screen.getByText("line 40")).toBeInTheDocument();

    const body = screen.getByTestId("install-output").element();
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(body.scrollHeight - body.scrollTop).toBe(body.clientHeight);
  });

  it("cancels an update waiting for sessions", async () => {
    const { screen, calls, installJob } = await piSection({ latest: "0.81.0" });

    installJob.setState(job({ jobId: "j7", state: "waiting", running: 1 }), true);
    await screen.getByRole("button", { name: "取消" }).click();

    expect(calls).toStrictEqual(["cancelInstall j7"]);
  });

  it("shows a failed update's whole output with 重试, and the manual way open", async () => {
    const { screen, calls, installJob } = await piSection({ latest: "0.81.0" });

    installJob.setState(job({ state: "failed", exitCode: 1, reason: "exit" }, "npm ERR! code EACCES\n"), true);

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("没有装好pi update 退出码 1，完整日志在下面重试更新 pinpm ERR! code EACCES");
    await expect.element(screen.getByRole("log", { name: "更新 pi" })).toHaveTextContent("更新 pinpm ERR! code EACCES");
    const manual = screen.getByRole("button", { name: "手动更新" });
    await expect.element(manual).toHaveAttribute("aria-expanded", "true");
    await screen.getByRole("button", { name: "我更新好了，重新检测" }).click();
    await screen.getByRole("button", { name: "重试" }).click();
    await manual.click();
    await expect.element(manual).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByRole("button", { name: "我更新好了，重新检测" })).not.toBeInTheDocument();
    expect(calls).toStrictEqual(["loadSetup refresh", "updatePi"]);
  });

  it("says how an update failed that ended without an exit code or did not start", async () => {
    const { screen, installJob } = await piSection({ latest: "0.81.0" });
    const block = screen.getByRole("status");

    installJob.setState(job({ state: "failed", exitCode: null, reason: "exit" }), true);
    await expect.element(block).toHaveTextContent("没有装好pi update 被中途结束了，完整日志在下面重试更新 pi");
    installJob.setState(job({ state: "failed", exitCode: null, reason: "spawn_failed" }), true);
    await expect.element(block).toHaveTextContent("没有装好启动不了 pi update重试更新 pi");
  });

  it("shows an update as not started once it was cancelled, and ignores other install jobs", async () => {
    const { screen, installJob } = await piSection({ latest: "0.81.0" });
    const block = screen.getByRole("status");

    installJob.setState(job({ state: "cancelled" }), true);
    await expect.element(block).toHaveTextContent(OFFERED);
    installJob.setState(job({ kind: "install_pi", state: "failed", exitCode: 1, reason: "exit" }), true);
    await expect.element(block).toHaveTextContent(OFFERED);
    await expect.element(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  });

  it("copies the manual command, folded until asked", async () => {
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      written.push(text);
    });
    const { screen } = await piSection();
    const manual = screen.getByRole("button", { name: "手动更新" });

    await expect.element(manual).toHaveAttribute("aria-expanded", "false");
    await manual.click();
    await expect.element(screen.getByText("$ pi update")).toBeVisible();
    await screen.getByRole("button", { name: "复制" }).click();

    await expect.element(screen.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(written).toStrictEqual(["pi update"]);
  });

  it("says why an update could not start", async () => {
    const answers = { updatePi: () => Promise.reject(new CommandError("install_busy")) };
    const { screen } = await piSection({ latest: "0.81.0" }, { answers });

    await screen.getByRole("button", { name: "更新 pi" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("另一个安装任务正在进行，等它结束再试");
  });

  it("says when pi's state cannot be read", async () => {
    const fake = fakeClient();
    fake.setup.setState({ status: "failed", state: null, error: new Error("closed") });
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

    await expect.element(screen.getByText("读不到 pi 的状态")).toBeVisible();
    fake.setup.setState({ status: "loading" });
    await expect.element(screen.getByText("正在读取…")).toBeVisible();
  });
});

import { type AtriumClient, CommandError, type InstallJob } from "@atrium/client";
import type { InstallKind, SetupState } from "@atrium/protocol";
import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { PiMark } from "../settings/parts";
import { InstallTerminal } from "./install-terminal";
import { CHIP, CopyChip, EnterHint, FOOT_GHOST, FOOT_PRIMARY, FootSpinner, StepLayout } from "./step-layout";

/** The two ways to install pi by hand (SPEC-0001, "首次启动 · 第 1 步"). */
const COMMANDS = {
  script: "curl -fsSL https://pi.dev/install.sh | sh",
  npm: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
} as const;

/** Where to download Node.js without Homebrew. */
const NODE_DOWNLOAD = "https://nodejs.org/";

/**
 * What step 1 shows: still checking, the check failed, pi ready, pi to update, Node.js to install
 * first, or pi to install.
 */
type Variant = "checking" | "unchecked" | "ready" | "update" | "node" | "install";

/** The install job each variant runs. */
const JOB_KINDS: Partial<Record<Variant, InstallKind>> = {
  update: "update_pi",
  node: "install_node",
  install: "install_pi",
};

/**
 * What step 1 shows for what first launch checks.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 1 步"): pi too old is updated; pi missing or broken is installed, Node.js
 * first when it is missing or too old.
 *
 * @sideEffects none
 * @param status - Where asking stands.
 * @param state - What first launch checks, once known.
 * @returns The variant.
 */
function variantOf(status: string, state: SetupState | null): Variant {
  if (state === null) return status === "failed" ? "unchecked" : "checking";
  if (state.pi.state === "ready") return "ready";
  if (state.pi.state === "outdated") return "update";
  return state.node.state === "ready" ? "install" : "node";
}

/**
 * Why an install command was refused, in words.
 *
 * @remarks
 * The host sends codes only; the UI words them (AGENTS.md, "写代码").
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns The text.
 */
function describeRefusal(error: unknown): string {
  if (error instanceof CommandError && error.code === "install_busy") return "另一个安装任务正在进行，等它结束再试";
  if (error instanceof CommandError && error.code === "install_unavailable") return "还没检测到需要的工具，稍后再试";
  return "没做成，稍后再试";
}

/**
 * How a failed job's lead reads.
 *
 * @remarks
 * From the job's `reason` and exit code (SPEC-0001, "首次启动 · 接口"); the whole output is in the
 * terminal under it.
 *
 * @sideEffects none
 * @param job - The failed job.
 * @param what - What ran, as the user would type it.
 * @returns The lead.
 */
function failureLead(job: InstallJob, what: string): string {
  const rest = "可以重试，或者复制命令在终端里自己装。";
  if (job.job.reason === "download_failed") return `下载不了安装脚本，多半是网络问题。${rest}`;
  if (job.job.reason === "spawn_failed") return `启动不了 ${what}。${rest}`;
  if (job.job.exitCode === null) return `${what} 被中途结束了，完整日志在下面。${rest}`;
  return `${what} 退出码 ${job.job.exitCode}，完整日志在下面。${rest}`;
}

/**
 * Goes on once pi turns ready while the step shows.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 1 步"): once installed, first launch goes on by itself. A step reached
 * with pi ready already waits for "继续" instead.
 *
 * @sideEffects Calls `onNext` when pi turns ready.
 * @param ready - Whether pi is ready.
 * @param onNext - Going on.
 */
function useNextOnceReady(ready: boolean, onNext: () => void): void {
  const unready = useRef(false);
  useEffect(() => {
    if (!ready) unready.current = true;
    else if (unready.current) {
      unready.current = false;
      onNext();
    }
  }, [ready, onNext]);
}

/**
 * The footer's main button, which Enter presses.
 *
 * @remarks
 * See `useEnterToAdvance` in `first-launch.tsx`.
 *
 * @sideEffects none; pressing it calls `onClick`.
 * @param label - What it says.
 * @param onClick - What pressing does.
 * @returns The button.
 */
function primary(label: string, onClick: () => void) {
  return (
    <button type="button" data-enter className={FOOT_PRIMARY} onClick={onClick}>
      {label}
      <EnterHint />
    </button>
  );
}

/**
 * Step 1: install pi, or update it, or install Node.js first.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 1 步"). The host runs pi's install script, `brew install node` or
 * `pi update`, its output live in the terminal, cancellable; once Node.js is in, pi's install
 * follows by itself and shows at once, before the checks find Node.js, and once pi is ready the
 * step goes on. The manual way is always under the
 * terminal: the commands to copy, and "我已经装好了" in the footer to check again, which has the
 * host read the login shell again since the install may have changed `PATH` (2026-10-11 定).
 * Without Homebrew, Node.js is downloaded from nodejs.org. A broken pi shows its own error under
 * "展开看原始报错".
 *
 * @sideEffects Subscribes to the client's setup and install job; sends `install_pi`,
 * `install_node`, `update_pi`, `cancel_install` and `check_setup` when asked, and `install_pi`
 * once a Node.js install this window started succeeds; opens nodejs.org when asked; writes the
 * clipboard when asked.
 * @param props - The client, whether the step was reached going back, how to open an address,
 * going on, and going back (none when there is nothing before).
 * @returns The step, as the window's middle and bottom rows.
 */
export function InstallStep({
  client,
  back,
  openUrl,
  onNext,
  onBack,
}: {
  readonly client: AtriumClient;
  readonly back: boolean;
  readonly openUrl: (url: string) => void;
  readonly onNext: () => void;
  readonly onBack: (() => void) | undefined;
}) {
  const setup = useStore(client.setup);
  const shown = useStore(client.installJob);
  const [tab, setTab] = useState<keyof typeof COMMANDS>("script");
  const [checking, setChecking] = useState(false);
  const [rechecked, setRechecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [nodeJob, setNodeJob] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const state = setup.state;
  const checked = variantOf(setup.status, state);
  // pi's install that follows this window's Node.js install shows before the checks find Node.js.
  const variant = checked === "node" && nodeJob !== null && shown?.job.kind === "install_pi" ? "install" : checked;
  useNextOnceReady(variant === "ready", onNext);

  const nodeDone = shown?.job.kind === "install_node" && shown.job.state === "ok" && shown.job.jobId === nodeJob;
  useEffect(() => {
    if (!nodeDone) return;
    // Fire and forget: the job's progress arrives as install updates, a refusal is shown.
    void client.installPi().catch((error: unknown) => setProblem(describeRefusal(error)));
  }, [nodeDone, client]);

  const kind = JOB_KINDS[variant];
  const job = shown !== null && shown.job.kind === kind && shown.job.state !== "cancelled" ? shown : null;
  const jobState = job?.job.state;
  const running = jobState === "waiting" || jobState === "running";
  const phase = job === null ? "idle" : running ? "running" : jobState === "ok" ? "ok" : "failed";

  /**
   * Starts this variant's job.
   *
   * @remarks
   * A Node.js install remembers its id, so pi's install follows it.
   *
   * @sideEffects Sends `install_pi`, `install_node` or `update_pi`; updates the step's state.
   */
  const startJob = (): void => {
    setProblem(null);
    setRechecked(false);
    const command =
      variant === "node"
        ? client.installNode().then(({ jobId }) => setNodeJob(jobId))
        : variant === "update"
          ? client.updatePi()
          : client.installPi();
    // Fire and forget: the job's progress arrives as install updates, a refusal is shown.
    void command.catch((error: unknown) => setProblem(describeRefusal(error)));
  };

  /**
   * Checks again, the login shell read again first.
   *
   * @remarks
   * Says so when pi is still not there; once it is, the step goes on by itself.
   *
   * @sideEffects Sends `check_setup`; updates the step's state.
   */
  const recheck = async (): Promise<void> => {
    setChecking(true);
    setRechecked(false);
    await client.loadSetup(true);
    setChecking(false);
    setRechecked(true);
  };

  const backButton =
    onBack === undefined ? null : (
      <button type="button" className={FOOT_GHOST} onClick={onBack}>
        返回
      </button>
    );
  /**
   * The footer's button that checks again.
   *
   * @remarks
   * See `recheck`.
   *
   * @sideEffects none; pressing it checks again.
   * @param label - What it says.
   * @returns The button.
   */
  const recheckButton = (label: string) => (
    <button type="button" className={FOOT_GHOST} disabled={checking} onClick={() => void recheck()}>
      {checking ? "正在检测" : label}
    </button>
  );
  const runningFooter = (
    <>
      <button
        type="button"
        className={FOOT_GHOST}
        onClick={() => {
          // Fire and forget: the job's end arrives as an install update.
          if (job !== null) void client.cancelInstall(job.job.jobId).catch(() => undefined);
        }}
      >
        取消
      </button>
      <span className="flex-1" />
      <button type="button" data-enter disabled className={FOOT_PRIMARY}>
        <FootSpinner />
        {kind === "update_pi" ? "正在更新" : "正在安装"}
      </button>
    </>
  );
  const notes = (
    <>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-center text-[length:var(--fs-sm)] text-[var(--danger)]">
          {problem}
        </p>
      )}
      {rechecked && variant !== "ready" && !checking ? (
        <p role="status" className="mt-3 text-center text-[length:var(--fs-sm)] text-[var(--attn-text)]">
          {variant === "update" ? "还是旧版本，可能要重开终端" : "还是没找到，可能要重开终端"}
        </p>
      ) : null}
    </>
  );

  if (variant === "checking" || variant === "unchecked") {
    return (
      <StepLayout
        screen="install"
        back={back}
        eyebrow="第 1 步 · 安装 pi"
        title="先装好 pi"
        lead={variant === "checking" ? "正在检查这台电脑上的 pi…" : "没能检查这台电脑上的 pi，再试一次。"}
        footer={
          <>
            {backButton}
            <span className="flex-1" />
            {variant === "checking" ? (
              <button type="button" data-enter disabled className={FOOT_PRIMARY}>
                <FootSpinner />
                正在检查
              </button>
            ) : (
              primary("重新检测", () => void client.loadSetup(true))
            )}
          </>
        }
      >
        {null}
      </StepLayout>
    );
  }

  if (variant === "ready" && state !== null) {
    return (
      <StepLayout
        screen="install"
        back={back}
        eyebrow="第 1 步 · 安装 pi"
        title="pi 已就绪"
        lead="找到了 pi，终端里也能直接用。"
        footer={
          <>
            {backButton}
            <span className="flex-1" />
            {primary("继续", onNext)}
          </>
        }
      >
        <div className="atrium-onboard-show flex items-center gap-3 p-[18px]">
          <PiMark />
          <div className="min-w-0 flex-1">
            <div className="font-medium">pi {state.pi.version}</div>
            <div className="truncate font-mono text-[length:var(--fs-sm)] text-[var(--text-muted)]">
              {state.pi.path}
            </div>
          </div>
        </div>
      </StepLayout>
    );
  }

  if (variant === "node" && state !== null && !state.homebrew) {
    return (
      <StepLayout
        screen="node"
        back={back}
        eyebrow="第 1 步 · 安装 pi"
        title="还需要 Node.js"
        lead="pi 运行在 Node.js 上，先从 nodejs.org 下载安装。"
        footer={
          <>
            {backButton}
            {recheckButton("我已经装好了")}
            <span className="flex-1" />
            {primary("去 nodejs.org 下载", () => openUrl(NODE_DOWNLOAD))}
          </>
        }
      >
        <Needs state={state} />
        <p className="atrium-onboard-show p-[18px] text-center text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          装好 Node.js 22.19 或更高的版本后，回到这里点“我已经装好了”。
        </p>
        {notes}
      </StepLayout>
    );
  }

  const failed = phase === "failed" && job !== null;
  const landed = phase === "ok";
  const command = variant === "update" ? "pi update" : variant === "node" ? "brew install node" : COMMANDS[tab];
  const broken = variant === "install" && state?.pi.state === "broken";
  const titles: Readonly<Record<"update" | "node" | "install", string>> = {
    update: landed ? "更新好了" : "pi 需要更新",
    node: "还需要 Node.js",
    install: landed ? "装好了" : broken ? "pi 运行不了" : "先装好 pi",
  };
  const leads: Readonly<Record<"update" | "node" | "install", string>> = {
    update: `找到的 pi 是 ${state?.pi.version ?? ""}，Atrium 需要 ${state?.pi.minimum ?? ""} 或更高的版本。`,
    node: "pi 运行在 Node.js 上。用 Homebrew 装好后，会接着安装 pi。",
    install: broken
      ? "找到的 pi 启动不了，重新安装一次通常能修好。"
      : "Atrium 用 pi 作为 agent 内核，这台电脑上还没有找到它。",
  };
  const shownVariant = variant === "update" || variant === "node" ? variant : "install";
  const what = variant === "update" ? "pi update" : variant === "node" ? "brew install node" : "安装脚本";
  const lead = failed
    ? failureLead(job, what)
    : landed
      ? setup.status === "loading"
        ? "正在确认装好的能用…"
        : `跑完了，但还是找不到能用的 ${variant === "node" ? "Node.js" : "pi"}，可能要重开终端。`
      : leads[shownVariant];
  const under = running
    ? jobState === "waiting"
      ? `等待 ${job?.job.running ?? 0} 个会话运行结束，结束后自动开始`
      : "正在运行，可以随时取消"
    : failed
      ? "没有装好。可以重试，或复制命令自己装"
      : landed
        ? "完成"
        : "也可以复制命令，在终端里自己装";
  const action = variant === "update" ? "更新 pi" : variant === "node" ? "用 Homebrew 安装" : "安装 pi";

  return (
    <StepLayout
      screen={shownVariant}
      back={back}
      eyebrow={variant === "update" ? "第 1 步 · 更新 pi" : "第 1 步 · 安装 pi"}
      title={failed ? "没有装好" : titles[shownVariant]}
      lead={lead}
      footer={
        running ? (
          runningFooter
        ) : landed ? (
          <>
            {backButton}
            <span className="flex-1" />
            {setup.status === "loading" ? (
              <button type="button" data-enter disabled className={FOOT_PRIMARY}>
                <FootSpinner />
                正在检查
              </button>
            ) : (
              primary("重新检测", () => void recheck())
            )}
          </>
        ) : (
          <>
            {backButton}
            {variant === "node" ? (
              <button type="button" className={FOOT_GHOST} onClick={() => openUrl(NODE_DOWNLOAD)}>
                去 nodejs.org 下载
              </button>
            ) : (
              recheckButton(variant === "update" ? "我已经更新了" : "我已经装好了")
            )}
            <span className="flex-1" />
            {primary(failed ? "重试" : action, startJob)}
          </>
        )
      }
    >
      {variant === "node" && state !== null ? <Needs state={state} /> : null}
      {broken && state !== null && state.pi.detail !== null ? (
        <div className="mb-3.5 text-center">
          <button
            type="button"
            aria-expanded={detail}
            onClick={() => setDetail(!detail)}
            className="inline-flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-muted)] hover:text-[var(--text-2)]"
          >
            <CaretRight size={11} className={`transition-transform ${detail ? "rotate-90" : ""}`} />
            展开看原始报错
          </button>
          {detail ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded-[var(--r-md)] bg-[var(--code)] p-3 text-left font-mono text-[length:var(--fs-sm)] whitespace-pre-wrap text-[var(--text-3)]">
              {state.pi.detail}
            </pre>
          ) : null}
        </div>
      ) : null}
      <div className="atrium-onboard-show p-[18px]">
        <InstallTerminal
          title={variant === "update" ? "更新 pi" : variant === "node" ? "安装 Node.js" : "安装 pi"}
          output={job?.output ?? ""}
          phase={phase}
          idle={{ hint: `点“${action}”后，这里显示实时输出`, command }}
        />
        <div className="mt-3 flex items-center justify-between gap-3 px-1 text-[12.5px] text-[var(--text-muted)]">
          <span>{under}</span>
          <span className="flex shrink-0 gap-1.5">
            {variant === "install"
              ? (["script", "npm"] as const).map((one) => (
                  <button
                    key={one}
                    type="button"
                    className={CHIP}
                    aria-pressed={tab === one}
                    onClick={() => setTab(one)}
                  >
                    {one === "script" ? "安装脚本" : "npm"}
                  </button>
                ))
              : null}
            <CopyChip text={command} label={`复制 ${command}`} />
          </span>
        </div>
      </div>
      {notes}
    </StepLayout>
  );
}

/**
 * What pi needs and what was found: Node.js, and Homebrew to install it with.
 *
 * @remarks
 * Above step 1's showcase while Node.js is missing or too old (SPEC-0001, "首次启动 · 第 1 步").
 *
 * @sideEffects none
 * @param props - What first launch checks.
 * @returns The chips.
 */
function Needs({ state }: { readonly state: SetupState }) {
  const chip =
    "inline-flex h-7 items-center rounded-[var(--r-pill)] bg-[var(--onb-panel)] px-3 text-[12.5px] shadow-[inset_0_0_0_0.5px_var(--onb-panel-edge)]";
  return (
    <div className="mb-3.5 flex justify-center gap-2.5">
      <span className={`${chip} text-[var(--danger)]`}>
        {state.node.state === "missing"
          ? "Node.js 22.19+ 未找到"
          : `Node.js ${state.node.version ?? ""} 太旧，需要 22.19+`}
      </span>
      <span className={`${chip} text-[var(--text-3)]`}>{state.homebrew ? "Homebrew 已安装" : "没有 Homebrew"}</span>
    </div>
  );
}

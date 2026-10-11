import { type AtriumClient, CommandError, type InstallJob } from "@atrium/client";
import type { SetupPi } from "@atrium/protocol";
import {
  ArrowsClockwise,
  CaretRight,
  Check,
  CheckCircle,
  Copy,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { useStore } from "zustand";
import { InstallTerminal } from "../setup/install-terminal";
import { piUpdateAvailable } from "../setup/pi-version";
import { timeAgo } from "../sidebar/names";
import { useClock } from "../state/clock";
import { BUTTON, GHOST_BUTTON, Group, LINK_BUTTON, PRIMARY_BUTTON, PiMark, Row, Spinner } from "./parts";

/**
 * The settings' pi: where it is, its version, the latest one, and updating it.
 *
 * @remarks
 * SPEC-0001 ("设置 · pi"): an update waits for running sessions, shows its output while running,
 * the whole of it with "重试" once failed, and the version reached once done, until a newer one is
 * found (2026-10-11 定). The manual way is
 * always there, and opens by itself after a failure. Updating runs the pi the user installed, so
 * the terminal's pi updates too.
 *
 * @sideEffects Subscribes to the client's setup and install job; sends `check_pi_update`,
 * `update_pi`, `cancel_install` and `check_setup` when asked; may show a path in the Finder; writes
 * the clipboard when asked.
 * @param props - The client, and how to show a path in the Finder (none outside the desktop app).
 * @returns The section.
 */
export function PiSection({
  client,
  reveal,
}: {
  readonly client: AtriumClient;
  readonly reveal: ((path: string) => void) | undefined;
}) {
  const setup = useStore(client.setup);
  const job = useStore(client.installJob, (shown) => (shown?.job.kind === "update_pi" ? shown : null));
  const now = useClock().now();
  const [checking, setChecking] = useState(false);
  // `null` until toggled: then it opens by itself once an update failed.
  const [manual, setManual] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pi = setup.state?.pi;
  if (pi === undefined) {
    return (
      <p className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">
        {setup.status === "failed" ? "读不到 pi 的状态" : "正在读取…"}
      </p>
    );
  }
  const busy = job?.job.state === "waiting" || job?.job.state === "running";
  const failed = job?.job.state === "failed";

  /**
   * Runs a command of this section, showing why it failed.
   *
   * @remarks
   * The section's commands have no other place to report.
   *
   * @sideEffects Runs the command; may set the problem line.
   * @param command - The command.
   */
  const run = (command: () => Promise<unknown>): void => {
    setProblem(null);
    // Fire and forget: the failure is shown.
    void command().catch((error: unknown) => setProblem(describeFailure(error)));
  };

  /**
   * Has the host look for the latest pi, marking the button meanwhile.
   *
   * @remarks
   * What it finds lands in the setup the section shows.
   *
   * @sideEffects Sends `check_pi_update`; updates the section's state.
   */
  const check = (): void => {
    setChecking(true);
    run(async () => {
      try {
        await client.checkPiUpdate();
      } finally {
        setChecking(false);
      }
    });
  };

  return (
    <>
      <Group>
        <Row
          lead={<PiMark />}
          label="pi"
          detail="Atrium 和终端用的是同一个 pi"
          controls={
            <a className={LINK_BUTTON} href="https://pi.dev" target="_blank" rel="noreferrer">
              pi.dev ↗
            </a>
          }
        />
        <Row
          compact
          label="位置"
          controls={
            <>
              <span className="font-mono text-[length:var(--fs-sm)] text-[var(--text-2)]">{pi.path ?? "找不到"}</span>
              {pi.path === null || reveal === undefined ? null : (
                <button type="button" className={GHOST_BUTTON} onClick={() => reveal(pi.path ?? "")}>
                  在访达中显示
                </button>
              )}
            </>
          }
        />
        <Row compact label="当前版本" controls={<Value>{pi.version ?? "—"}</Value>} />
        <Row
          compact
          label="最新版本"
          controls={
            <Value>
              {pi.latest ?? "—"}
              {pi.latest !== null && pi.version !== null && !piUpdateAvailable(pi) ? <UpToDate /> : null}
            </Value>
          }
        />
        <Row
          compact
          label="上次检查"
          controls={
            <>
              <Value>{pi.checkedAt === null ? "还没查过" : timeAgo(pi.checkedAt, now)}</Value>
              <button type="button" className={BUTTON} disabled={busy || checking} onClick={check}>
                {checking ? (
                  <>
                    <Spinner />
                    正在检查
                  </>
                ) : (
                  <>
                    <ArrowsClockwise size={13} />
                    检查更新
                  </>
                )}
              </button>
            </>
          }
        />
      </Group>
      <Group
        title="更新"
        footer="宿主每天查一次 npm 上的最新版本，有新版本时在这里显示“更新 pi”，不打断使用。有会话在运行时，更新等它们结束再开始。"
      >
        <div className="mx-3">
          <UpdateBlock
            pi={pi}
            settling={setup.status === "loading"}
            job={job}
            onUpdate={() => run(() => client.updatePi())}
            onCancel={(jobId) => run(() => client.cancelInstall(jobId))}
          />
          {problem === null ? null : (
            <p role="alert" className="mt-2 text-[length:var(--fs-sm)] text-[var(--danger)]">
              {problem}
            </p>
          )}
          {job?.job.state === "running" ? null : (
            <ManualUpdate
              open={manual ?? failed}
              onToggle={() => setManual(!(manual ?? failed))}
              onRecheck={() => run(() => client.loadSetup(true))}
            />
          )}
        </div>
      </Group>
    </>
  );
}

/**
 * Why a command of the pi section failed, in words.
 *
 * @remarks
 * The host sends codes only; the UI words them (AGENTS.md, "写代码").
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns The text.
 */
function describeFailure(error: unknown): string {
  if (error instanceof CommandError && error.code === "install_busy") return "另一个安装任务正在进行，等它结束再试";
  if (error instanceof CommandError && error.code === "install_unavailable") return "找不到 pi，没法更新";
  return "没做成，稍后再试";
}

/**
 * A value on the right of a row.
 *
 * @remarks
 * Versions and times, in figures that do not jump.
 *
 * @sideEffects none
 * @param props - The value.
 * @returns The value.
 */
function Value({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[length:var(--fs-meta)] text-[var(--text-2)] tabular-nums">
      {children}
    </span>
  );
}

/**
 * "已是最新", with a tick.
 *
 * @remarks
 * Beside the latest version when it is the one installed.
 *
 * @sideEffects none
 * @returns The mark.
 */
function UpToDate() {
  return (
    <span className="inline-flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--ok-text)]">
      <Check size={12} weight="bold" />
      已是最新
    </span>
  );
}

/**
 * Where updating pi is: offered, waiting, running, failed or done.
 *
 * @remarks
 * See `PiSection`. A cancelled update shows as if none had started. A done update gives way to a
 * newer pi found since; while the checks after it are on their way, pi still has the old version,
 * so it shows done without one.
 *
 * @sideEffects none; the buttons call back.
 * @param props - pi, whether the checks are on their way, the update job if any, and what the
 * buttons do.
 * @returns The block.
 */
function UpdateBlock({
  pi,
  settling,
  job,
  onUpdate,
  onCancel,
}: {
  readonly pi: SetupPi;
  readonly settling: boolean;
  readonly job: InstallJob | null;
  readonly onUpdate: () => void;
  readonly onCancel: (jobId: string) => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const state = job?.job.state;
  if (job !== null && state === "waiting") {
    const running = job.job.running ?? 0;
    return (
      <Block
        tone="linked"
        icon={<Spinner />}
        title={`等待 ${running} 个会话运行结束`}
        detail="结束后自动开始更新"
        controls={
          <button type="button" className={GHOST_BUTTON} onClick={() => onCancel(job.job.jobId)}>
            取消
          </button>
        }
      />
    );
  }
  if (job !== null && state === "running") {
    return (
      <Block
        icon={<Spinner />}
        title={pi.latest === null ? "正在更新" : `正在更新到 ${pi.latest}`}
        detail="新开的会话会等更新完成再启动 pi"
        controls={
          <button type="button" className={GHOST_BUTTON} onClick={() => onCancel(job.job.jobId)}>
            取消
          </button>
        }
      >
        <InstallTerminal title="更新 pi" output={job.output} phase="running" />
      </Block>
    );
  }
  if (job !== null && state === "failed") {
    return (
      <Block
        tone="danger"
        icon={<WarningCircle size={20} />}
        title="没有装好"
        detail={
          job.job.reason === "spawn_failed"
            ? "启动不了 pi update"
            : job.job.exitCode === null
              ? "pi update 被中途结束了，完整日志在下面"
              : `pi update 退出码 ${job.job.exitCode}，完整日志在下面`
        }
        controls={
          <button type="button" className={PRIMARY_BUTTON} onClick={onUpdate}>
            重试
          </button>
        }
      >
        <InstallTerminal title="更新 pi" output={job.output} phase="failed" />
      </Block>
    );
  }
  if (job !== null && state === "ok" && (settling || !piUpdateAvailable(pi))) {
    return (
      <Block
        icon={<CheckCircle size={20} className="text-[var(--ok-text)]" />}
        title={settling ? "已更新" : `已更新到 ${pi.version ?? ""}`}
        detail="空闲会话的 pi 在下次使用时用新版本重启"
        controls={
          <button type="button" className={GHOST_BUTTON} aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            {showLog ? "收起日志" : "查看日志"}
          </button>
        }
      >
        {showLog ? <InstallTerminal title="更新 pi" output={job.output} phase="ok" /> : null}
      </Block>
    );
  }
  if (piUpdateAvailable(pi)) {
    return (
      <Block
        tone="linked"
        icon={<DownloadSimple size={20} className="text-[var(--tint)]" />}
        title={`有新版本 ${pi.latest ?? ""}`}
        detail={`当前 ${pi.version ?? ""}。更新的是你装的这个 pi，终端里的 pi 也会一起更新`}
        controls={
          <button type="button" className={PRIMARY_BUTTON} onClick={onUpdate}>
            更新 pi
          </button>
        }
      />
    );
  }
  return (
    <Block
      icon={<CheckCircle size={20} className="text-[var(--ok-text)]" />}
      title={pi.latest === null ? "还不知道最新版本" : "pi 已是最新版本"}
      detail="有新版本时这里会出现“更新 pi”"
    />
  );
}

/**
 * A framed block with an icon, a title and a line, its buttons on the right and more below.
 *
 * @remarks
 * Tinted while an update is offered or waiting, red once it failed (design-language, "设置").
 *
 * @sideEffects none
 * @param props - The tone, icon, title, line, buttons and what goes under them.
 * @returns The block.
 */
function Block({
  tone,
  icon,
  title,
  detail,
  controls,
  children,
}: {
  readonly tone?: "linked" | "danger";
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly controls?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={`rounded-[var(--r-btn)] px-3.5 py-3 ${
        tone === "linked"
          ? "bg-[var(--linked)] shadow-[inset_0_0_0_0.5px_var(--line-strong)]"
          : tone === "danger"
            ? "bg-[var(--danger-soft)] shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--danger)_45%,transparent)]"
            : "shadow-[inset_0_0_0_0.5px_var(--line)]"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex w-5 shrink-0 justify-center ${tone === "danger" ? "text-[var(--danger)]" : "text-[var(--tint)]"}`}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <b className={`block font-medium ${tone === "danger" ? "text-[var(--danger)]" : ""}`}>{title}</b>
          <small className="block text-[length:var(--fs-sm)] text-[var(--text-muted)]">{detail}</small>
        </div>
        <div className="flex shrink-0 items-center gap-2">{controls}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * The manual way to update: the command to copy, and "我更新好了，重新检测".
 *
 * @remarks
 * See `PiSection`. Checking again has the host read the login shell again, in case the update
 * moved pi.
 *
 * @sideEffects Writes the clipboard when asked; the buttons call back.
 * @param props - Whether it is open, and what toggling and checking again do.
 * @returns The disclosure.
 */
function ManualUpdate({
  open,
  onToggle,
  onRecheck,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onRecheck: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex items-center gap-1 py-0.5 text-[length:var(--fs-sm)] text-[var(--text-muted)] hover:text-[var(--text-2)]"
      >
        <CaretRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        手动更新
      </button>
      {open ? (
        <div className="mt-2 ml-4 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          在终端里运行：
          <div className="my-1.5 flex items-center gap-2 rounded-[var(--r)] bg-[var(--code)] py-1 pr-1 pl-3 shadow-[inset_0_0_0_0.5px_var(--line)]">
            <code className="flex-1 font-mono text-[length:var(--fs-sm)] text-[var(--text-2)]">
              <span className="text-[var(--text-dim)]">$ </span>pi update
            </code>
            <button
              type="button"
              className={GHOST_BUTTON}
              onClick={() => {
                // Fire and forget: the command stays on screen to copy by hand.
                void navigator.clipboard.writeText("pi update").then(
                  () => setCopied(true),
                  () => undefined,
                );
              }}
            >
              {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <button type="button" className={LINK_BUTTON} onClick={onRecheck}>
            我更新好了，重新检测
          </button>
        </div>
      ) : null}
    </div>
  );
}

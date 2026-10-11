import type { AtriumClient } from "@atrium/client";
import { useState } from "react";
import { useStore } from "zustand";
import { KeyForm, SubscriptionList, useLoginFlow } from "./login-flow";
import { keyCandidates } from "./providers";
import { CopyChip, EnterHint, FOOT_GHOST, FOOT_PRIMARY, StepLayout } from "./step-layout";

/** The two ways to log in on step 2. */
const WAYS = [
  { way: "subscription", name: "用订阅登录" },
  { way: "key", name: "使用 API Key" },
] as const;

/**
 * Step 2: log in to a model, with a subscription or an API key.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 2 步"): the same subscription list and key form as the settings,
 * credentials stored in pi so the terminal's pi uses them too. "继续" waits for at least one
 * credential, a key from the environment included. When Atrium cannot log in through pi, the
 * step says to run `/login` in the terminal's pi and offers to check again; it cannot tell
 * whether that worked, so "继续" stays open (2026-10-11 定).
 *
 * @sideEffects Subscribes to the client's setup and login state; sends login commands and
 * `check_setup` when asked; opens addresses; writes the clipboard when asked.
 * @param props - The client, whether the step was reached going back, how to open an address,
 * going on and going back.
 * @returns The step, as the window's middle and bottom rows.
 */
export function LoginStep({
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
  readonly onBack: () => void;
}) {
  const login = useStore(client.setup, (setup) => setup.state?.login ?? null);
  const flow = useLoginFlow(client, openUrl);
  const [way, setWay] = useState<(typeof WAYS)[number]["way"]>("subscription");
  const [checking, setChecking] = useState(false);
  const providers = login?.state === "ready" ? login.providers : [];
  const unavailable = login?.state === "unavailable";
  const ready = unavailable || providers.some((provider) => provider.signedIn !== null);

  /**
   * Checks again after logging in from the terminal.
   *
   * @remarks
   * See `LoginStep`.
   *
   * @sideEffects Sends `check_setup`; updates the step's state.
   */
  const recheck = async (): Promise<void> => {
    setChecking(true);
    await client.loadSetup();
    setChecking(false);
  };

  return (
    <StepLayout
      screen="login"
      back={back}
      eyebrow="第 2 步 · 登录模型"
      title="登录一个模型"
      lead="凭据保存在 pi 里，终端里的 pi 也能直接用。"
      footer={
        <>
          <button type="button" className={FOOT_GHOST} onClick={onBack}>
            返回
          </button>
          <span className="flex-1" />
          <button type="button" data-enter disabled={!ready} className={FOOT_PRIMARY} onClick={onNext}>
            继续
            <EnterHint />
          </button>
        </>
      }
    >
      {unavailable ? (
        <div className="atrium-onboard-show p-[18px] text-center text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          <p className="m-0">Atrium 加载不了你装的 pi，没法在这里登录。</p>
          <p className="mt-2 mb-3 flex items-center justify-center gap-2">
            在终端运行 <code className="font-mono text-[var(--text-2)]">pi</code>，输入{" "}
            <code className="font-mono text-[var(--text-2)]">/login</code>
            <CopyChip text="pi" label="复制 pi" />
          </p>
          <button
            type="button"
            className="text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline disabled:opacity-45"
            disabled={checking}
            onClick={() => void recheck()}
          >
            {checking ? "正在检测" : "我登录好了，重新检测"}
          </button>
        </div>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label="登录方式"
            className="mx-auto -mt-1.5 mb-[18px] flex w-fit rounded-[12px] bg-[var(--selected)] p-[3px]"
          >
            {WAYS.map((one) => (
              <button
                key={one.way}
                type="button"
                role="radio"
                aria-checked={way === one.way}
                onClick={() => setWay(one.way)}
                className={`h-[30px] rounded-[9px] px-4 text-[13px] transition-colors ${
                  way === one.way
                    ? "bg-[var(--onb-panel-2)] text-[var(--text)] shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_var(--onb-panel-edge)]"
                    : "text-[var(--text-muted)]"
                }`}
              >
                {one.name}
              </button>
            ))}
          </div>
          {flow.problem === null ? null : (
            <p role="alert" className="mb-3 text-center text-[length:var(--fs-sm)] text-[var(--danger)]">
              {flow.problem}
            </p>
          )}
          {way === "subscription" ? (
            <>
              <div className="atrium-onboard-show p-1.5">
                <SubscriptionList providers={providers} flow={flow} openUrl={openUrl} />
              </div>
              <p className="mt-3 text-center text-[12.5px] text-[var(--text-dim)]">
                点“登录”会打开浏览器，在官网完成授权后自动回到这里
              </p>
            </>
          ) : (
            <>
              <div className="atrium-onboard-show p-[18px]">
                <KeyForm flow={flow} candidates={keyCandidates(providers)} openUrl={openUrl} />
              </div>
              <p className="mt-3 text-center text-[12.5px] text-[var(--text-dim)]">
                Key 写在 <code className="font-mono text-[11.5px]">~/.pi/agent/auth.json</code>，只保存在这台电脑上
              </p>
            </>
          )}
        </>
      )}
    </StepLayout>
  );
}

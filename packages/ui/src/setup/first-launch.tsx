import type { AtriumClient, IndexView, SetupView } from "@atrium/client";
import type { SetupState } from "@atrium/protocol";
import { Check } from "@phosphor-icons/react";
import { Fragment, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { InstallStep } from "./install-step";
import { LoginStep } from "./login-step";
import { ProjectsStep } from "./projects-step";
import { Welcome } from "./welcome";

/**
 * How first launch begins: on the welcome page, or straight at step 1 because pi cannot be used.
 */
export type FirstLaunchStart = "welcome" | "install";

/** A step of first launch, after the welcome page. */
type Step = 1 | 2 | 3;

/** The steps, as the stepper names them. */
const STEPS: readonly { readonly step: Step; readonly name: string }[] = [
  { step: 1, name: "安装 pi" },
  { step: 2, name: "登录模型" },
  { step: 3, name: "添加项目" },
];

/**
 * Whether first launch shows, and how it begins.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 什么时候显示"): while `setupDone` is false it begins on the welcome page;
 * afterwards only while pi cannot be used (missing, broken or too old), straight at step 1. Until
 * the host's first list arrives `setupDone` is unknown, so the answer is to wait. A setup not
 * read yet does not hold the workbench back.
 *
 * @sideEffects none
 * @param index - The list.
 * @param setup - What first launch checks, as far as asked.
 * @param finished - Whether first launch was finished in this window, before the host's list says so.
 * @returns How it begins, `"wait"` for the list, or `null` when it does not show.
 */
export function firstLaunchStart(
  index: IndexView,
  setup: SetupView,
  finished: boolean,
): FirstLaunchStart | "wait" | null {
  if (!index.ready) return "wait";
  if (!index.preferences.setupDone && !finished) return "welcome";
  if (setup.state !== null && setup.state.pi.state !== "ready") return "install";
  return null;
}

/**
 * Whether a step needs nothing done.
 *
 * @remarks
 * SPEC-0001 ("首次启动"): a step already satisfied is skipped going forward. Logging in is
 * satisfied by any credential pi has, a key from the environment included; when Atrium cannot
 * log in through pi it cannot tell, so the step shows.
 *
 * @sideEffects none
 * @param step - The step.
 * @param state - What first launch checks.
 * @returns Whether it is satisfied.
 */
function satisfied(step: Step, state: SetupState): boolean {
  if (step === 1) return state.pi.state === "ready";
  if (step === 2) return state.login.state === "ready" && state.login.providers.some((one) => one.signedIn !== null);
  return state.projects > 0;
}

/**
 * Presses the main button of the screen on Enter.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 窗口与版式"). The main button is marked `data-enter`; a disabled one
 * ignores the press. Enter in a field, on another button or link, or while an input method composes,
 * stays theirs.
 *
 * @sideEffects Listens for keys on the window while mounted; may press a button.
 * @param root - The first launch window.
 */
function useEnterToAdvance(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    /**
     * Presses the main button.
     *
     * @remarks
     * See `useEnterToAdvance`.
     *
     * @sideEffects May press a button; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, button, a") !== null) return;
      const primary = root.current?.querySelector<HTMLButtonElement>("[data-enter]");
      if (primary === null || primary === undefined) return;
      event.preventDefault();
      primary.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);
}

/**
 * First launch: the welcome page, then installing pi, logging in and adding projects.
 *
 * @remarks
 * SPEC-0001 ("首次启动"). The whole window, without the sidebar: faint ambient lights that drift
 * as the steps go on, the stepper on top, each step's footer at the bottom. Going forward skips
 * the steps already satisfied; finishing the last, or having nothing left to do, sets `setupDone`
 * and hands over to the workbench. Begun because pi cannot be used, only pi's step matters: once
 * pi is ready, first launch ends (2026-10-11 定). Going back reaches each earlier step, the welcome
 * page only when first launch began there.
 *
 * @sideEffects Subscribes to the client's setup and list; listens for Enter; through its steps,
 * sends install, login and project commands and `set_preferences`.
 * @param props - The client, how it begins, what finishing does, how to open an address, how to
 * choose a folder and how to read a dropped folder's path (neither outside the desktop app).
 * @returns The window.
 */
export function FirstLaunch({
  client,
  start,
  onDone,
  openUrl,
  pickDirectory,
  pathForFile,
}: {
  readonly client: AtriumClient;
  readonly start: FirstLaunchStart;
  readonly onDone: () => void;
  readonly openUrl: (url: string) => void;
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly pathForFile: ((file: File) => string | null) | undefined;
}) {
  const setup = useStore(client.setup);
  const setupDone = useStore(client.index, (index) => index.preferences.setupDone);
  const [screen, setScreen] = useState<0 | Step>(start === "welcome" ? 0 : 1);
  const [back, setBack] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEnterToAdvance(root);
  const state = setup.state;

  const finish = useCallback((): void => {
    // Fire and forget: the window hands over at once; should the host miss it, first launch
    // shows again next time.
    if (!setupDone) void client.setPreferences({ setupDone: true }).catch(() => undefined);
    onDone();
  }, [client, setupDone, onDone]);

  const forward = useCallback(
    (from: 0 | Step): void => {
      const next =
        start === "install" && from >= 1
          ? undefined
          : STEPS.find(({ step }) => step > from && (state === null || !satisfied(step, state)))?.step;
      if (next === undefined) {
        finish();
        return;
      }
      setBack(false);
      setScreen(next);
    },
    [start, state, finish],
  );

  /**
   * Goes to the screen before.
   *
   * @remarks
   * See `FirstLaunch`.
   *
   * @sideEffects Sets component state.
   * @param to - The screen.
   */
  const backTo = (to: 0 | Step): void => {
    setBack(true);
    setScreen(to);
  };

  return (
    <div ref={root} className="atrium-onboard" data-step={screen}>
      <div aria-hidden className="atrium-onboard-ambient">
        <i />
        <i />
        <i />
      </div>
      <div className="relative flex items-center justify-center [-webkit-app-region:drag]">
        {screen === 0 ? null : <Stepper current={screen} />}
      </div>
      {screen === 0 ? (
        <Welcome onStart={() => forward(0)} openUrl={openUrl} />
      ) : screen === 1 ? (
        <InstallStep
          client={client}
          back={back}
          openUrl={openUrl}
          onNext={() => forward(1)}
          onBack={start === "welcome" ? () => backTo(0) : undefined}
        />
      ) : screen === 2 ? (
        <LoginStep client={client} back={back} openUrl={openUrl} onNext={() => forward(2)} onBack={() => backTo(1)} />
      ) : (
        <ProjectsStep
          client={client}
          back={back}
          pickDirectory={pickDirectory}
          pathForFile={pathForFile}
          onDone={finish}
          onBack={() => backTo(2)}
        />
      )}
    </div>
  );
}

/**
 * The stepper: "安装 pi → 登录模型 → 添加项目", earlier steps ticked.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 窗口与版式"). The current step's number is filled; the list names the
 * steps for assistive technology and marks the current one.
 *
 * @sideEffects none
 * @param props - The current step.
 * @returns The stepper.
 */
function Stepper({ current }: { readonly current: Step }) {
  return (
    <ol
      aria-label="设置步骤"
      className="m-0 flex list-none items-center gap-2.5 p-0 text-[12.5px] text-[var(--text-dim)]"
    >
      {STEPS.map(({ step, name }) => {
        const done = step < current;
        const now = step === current;
        return (
          <Fragment key={step}>
            {step === 1 ? null : <li aria-hidden className="h-px w-7 bg-[var(--line)]" />}
            <li
              aria-current={now ? "step" : undefined}
              className={`flex items-center gap-[7px] whitespace-nowrap transition-colors duration-300 ${
                now ? "font-medium text-[var(--text)]" : done ? "text-[var(--text-muted)]" : ""
              }`}
            >
              <span
                className={`grid size-[18px] place-items-center rounded-full text-[10.5px] font-semibold transition-all duration-300 ${
                  now
                    ? "bg-[var(--onb-primary)] text-[var(--onb-on-primary)]"
                    : done
                      ? "bg-[var(--onb-ok-soft)] text-[var(--ok-text)]"
                      : "shadow-[inset_0_0_0_1px_var(--line)]"
                }`}
              >
                {done ? <Check size={10} weight="bold" aria-label="已完成" /> : step}
              </span>
              {name}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

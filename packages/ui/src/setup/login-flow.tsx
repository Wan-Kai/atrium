import { type AtriumClient, CommandError } from "@atrium/client";
import type {
  LoginFailureReason,
  LoginMethod,
  LoginQuestion,
  LoginUpdatedEvent,
  SetupProvider,
} from "@atrium/protocol";
import { CaretRight, Check, Copy, MetaLogo } from "../design/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BUTTON, BrandTile, FIELD, GHOST_BUTTON, LINK_BUTTON, PRIMARY_BUTTON, Row, Spinner } from "../settings/parts";
import { subscriptionRows } from "./providers";

/** Logging in, as one window sees it. */
export interface LoginFlow {
  /** The latest state of the login under way or last ended, whichever window started it. */
  readonly login: LoginUpdatedEvent | null;
  /** The login this window started last. */
  readonly mine: string | null;
  /** Why the last start failed, in words; `null` when it did not. */
  readonly problem: string | null;
  /** Starts a login, cancelling one under way; `key` is for `api_key`. */
  start(providerId: string, method: LoginMethod, key?: string): void;
  /** Cancels the login under way. */
  cancel(): void;
  /** Answers one of pi's questions. */
  answer(promptId: number, value: string): void;
}

/**
 * Logging in through the host, opening the authorisation page of a login this window started.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 2 步"): every window sees the login under way, but only the one that
 * started it opens its address, once. The address may arrive before the host answers `login`, so
 * it opens once both are known.
 *
 * @sideEffects Subscribes to the client's login state; opens the authorisation page; sends
 * `login`, `cancel_login` and `answer_login` when asked.
 * @param client - The client.
 * @param openUrl - Opens an address in the system browser.
 * @returns The flow.
 */
export function useLoginFlow(client: AtriumClient, openUrl: (url: string) => void): LoginFlow {
  const login = useStore(client.loginState);
  const [mine, setMine] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const opened = useRef<string | null>(null);
  const url = login?.loginId === mine ? (login?.authUrl?.url ?? null) : null;
  useEffect(() => {
    if (url === null || opened.current === mine) return;
    opened.current = mine;
    openUrl(url);
  }, [url, mine, openUrl]);
  return {
    login,
    mine,
    problem,
    start(providerId, method, key) {
      setProblem(null);
      client.login(providerId, method, key).then(
        ({ loginId }) => setMine(loginId),
        (error: unknown) =>
          setProblem(
            error instanceof CommandError && error.code === "login_unavailable"
              ? "登录用不了：Atrium 加载不了你装的 pi"
              : "没能开始登录，稍后再试",
          ),
      );
    },
    cancel() {
      // Fire and forget: the login's end arrives with its state; one already over has nothing to cancel.
      if (login?.state === "running") void client.cancelLogin(login.loginId).catch(() => undefined);
    },
    answer(promptId, value) {
      // Fire and forget: the question goes once pi takes the answer; a late one is dropped.
      if (login?.state === "running") void client.answerLogin(login.loginId, promptId, value).catch(() => undefined);
    },
  };
}

/** Why a login failed, in words (SPEC-0001, "首次启动 · 接口"). */
const FAILURES: Readonly<Record<LoginFailureReason, string>> = {
  unavailable: "登录用不了：Atrium 加载不了你装的 pi",
  failed: "没有登录成功",
  timed_out: "等得太久，登录已取消",
  insecure_url: "pi 给的地址不是 https，已取消",
};

/**
 * Whether a login is under way for a provider and method.
 *
 * @remarks
 * Shown on that provider's row in every window.
 *
 * @sideEffects none
 * @param login - The login state.
 * @param providerId - The provider.
 * @param method - How it logs in.
 * @returns Whether it runs.
 */
function isLoggingIn(login: LoginUpdatedEvent | null, providerId: string, method: LoginMethod): boolean {
  return login?.state === "running" && login.providerId === providerId && login.method === method;
}

/**
 * What a login asks and says while under way, or why it failed.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 2 步"): the address to open again, a device code, pi's questions in
 * pi's own words, and a collapsed field for pasting the callback address when the browser is on
 * another machine. A failure keeps pi's own text under the reason.
 *
 * @sideEffects Writes the clipboard when asked; may open an address; answers pi through `flow`.
 * @param props - The flow, the login to show, and how to open an address.
 * @returns The details, or nothing when the login has none to show.
 */
function LoginDetails({
  flow,
  login,
  openUrl,
}: {
  readonly flow: LoginFlow;
  readonly login: LoginUpdatedEvent;
  readonly openUrl: (url: string) => void;
}) {
  if (login.state === "failed" && login.error !== null) {
    return (
      <div role="alert" className="mt-1.5 text-[length:var(--fs-sm)]">
        <span className="text-[var(--danger)]">{FAILURES[login.error.reason]}</span>
        {login.error.detail === null ? null : (
          <span className="block break-words text-[var(--text-dim)]">{login.error.detail}</span>
        )}
      </div>
    );
  }
  if (login.state !== "running") return null;
  const asked = login.questions.filter((question) => question.kind !== "manual_code");
  const manual = login.questions.find((question) => question.kind === "manual_code");
  return (
    <div className="mt-2 flex flex-col gap-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
      {login.progress === null ? null : <p>{login.progress}</p>}
      {login.authUrl === null ? null : (
        <p>
          浏览器没有打开？
          <button type="button" className={LINK_BUTTON} onClick={() => openUrl(login.authUrl?.url ?? "")}>
            打开授权页
          </button>
        </p>
      )}
      {login.deviceCode === null ? null : (
        <DeviceCode code={login.deviceCode.userCode} onOpen={() => openUrl(login.deviceCode?.verificationUri ?? "")} />
      )}
      {asked.map((question) => (
        <Question
          key={question.promptId}
          question={question}
          onAnswer={(value) => flow.answer(question.promptId, value)}
        />
      ))}
      {manual === undefined ? null : (
        <ManualCode question={manual} onAnswer={(value) => flow.answer(manual.promptId, value)} />
      )}
    </div>
  );
}

/**
 * A device code to type on the provider's page.
 *
 * @remarks
 * See `LoginDetails`.
 *
 * @sideEffects Writes the clipboard when asked; `onOpen` opens the page.
 * @param props - The code and how to open the page.
 * @returns The code.
 */
function DeviceCode({ code, onOpen }: { readonly code: string; readonly onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      在验证页输入
      <code
        aria-label="设备码"
        className="rounded-[var(--r-sm)] bg-[var(--code)] px-2 py-0.5 font-mono text-[length:var(--fs-meta)] tracking-wider text-[var(--text)]"
      >
        {code}
      </code>
      <button
        type="button"
        className={GHOST_BUTTON}
        onClick={() => {
          // Fire and forget: the code stays on screen to type by hand.
          void navigator.clipboard.writeText(code).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
        {copied ? "已复制" : "复制"}
      </button>
      <button type="button" className={BUTTON} onClick={onOpen}>
        打开验证页
      </button>
    </div>
  );
}

/**
 * One of pi's questions: a field, or a choice of options.
 *
 * @remarks
 * pi's words are shown as pi gives them, in English (SPEC-0001, "首次启动 · 第 2 步").
 *
 * @sideEffects `onAnswer` answers pi.
 * @param props - The question and how to answer it.
 * @returns The question.
 */
function Question({
  question,
  onAnswer,
}: {
  readonly question: LoginQuestion;
  readonly onAnswer: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  if (question.kind === "select") {
    return (
      <div role="group" aria-label={question.message} className="flex flex-col gap-1.5">
        <span className="text-[var(--text-2)]">{question.message}</span>
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <button key={option.id} type="button" className={BUTTON} onClick={() => onAnswer(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(value);
      }}
    >
      <label className="text-[var(--text-2)]" htmlFor={`question-${question.promptId}`}>
        {question.message}
      </label>
      <span className="flex gap-2">
        <input
          id={`question-${question.promptId}`}
          className={`${FIELD} flex-1`}
          type={question.kind === "secret" ? "password" : "text"}
          placeholder={question.placeholder ?? undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className={PRIMARY_BUTTON}>
          确定
        </button>
      </span>
    </form>
  );
}

/**
 * The collapsed field for pasting the callback address.
 *
 * @remarks
 * For a browser on another machine; pi waits for it and the local callback at once (SPEC-0001,
 * "首次启动 · 第 2 步").
 *
 * @sideEffects `onAnswer` answers pi.
 * @param props - pi's question and how to answer it.
 * @returns The disclosure.
 */
function ManualCode({
  question,
  onAnswer,
}: {
  readonly question: LoginQuestion;
  readonly onAnswer: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-2)]"
      >
        <CaretRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        浏览器在别的电脑上？粘贴回调地址
      </button>
      {open ? (
        <form
          className="mt-1.5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(value);
          }}
        >
          <input
            aria-label="回调地址"
            className={`${FIELD} flex-1 font-mono text-[length:var(--fs-sm)]`}
            placeholder={question.placeholder ?? question.message}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className={PRIMARY_BUTTON}>
            确定
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The subscriptions to log in with, each with its state.
 *
 * @remarks
 * Shared by first launch's second step and the settings (SPEC-0001, "设置 · 模型与账户"). A row
 * logging in is outlined, says to finish in the browser and can be cancelled, with what pi asks
 * under it; a failed one says why under it.
 *
 * @sideEffects Starts, cancels and answers logins through `flow`; may open addresses.
 * @param props - pi's providers, the flow, how to open an address, and what a signed-in row
 * offers besides "已登录", given the row's provider and title.
 * @returns The rows.
 */
export function SubscriptionList({
  providers,
  flow,
  openUrl,
  signedInControls,
}: {
  readonly providers: readonly SetupProvider[];
  readonly flow: LoginFlow;
  readonly openUrl: (url: string) => void;
  readonly signedInControls?: (provider: SetupProvider, title: string) => ReactNode;
}) {
  const { login } = flow;
  return subscriptionRows(providers).map(({ provider, title, plan, logo, fills }) => {
    const busy = isLoggingIn(login, provider.providerId, "oauth");
    const shown = login !== null && login.providerId === provider.providerId && login.method === "oauth" ? login : null;
    return (
      <Row
        key={provider.providerId}
        busy={busy}
        lead={<BrandTile logo={logo} fills={fills} name={title} fallback={<MetaLogo size={20} />} />}
        label={title}
        detail={plan ?? undefined}
        controls={
          busy ? (
            <>
              <Spinner />
              <span>在浏览器中完成登录</span>
              <button type="button" className={GHOST_BUTTON} onClick={() => flow.cancel()}>
                取消
              </button>
            </>
          ) : provider.signedIn === null ? (
            <button
              type="button"
              className={BUTTON}
              aria-label={`登录 ${title}`}
              onClick={() => flow.start(provider.providerId, "oauth")}
            >
              登录
            </button>
          ) : (
            <>
              <SignedIn />
              {signedInControls?.(provider, title)}
            </>
          )
        }
      >
        {shown === null || provider.signedIn !== null ? null : (
          <div className="pl-11">
            <LoginDetails flow={flow} login={shown} openUrl={openUrl} />
          </div>
        )}
      </Row>
    );
  });
}

/**
 * "已登录", with a tick.
 *
 * @remarks
 * On a row with a credential.
 *
 * @sideEffects none
 * @param props - The words, when not "已登录".
 * @returns The mark.
 */
export function SignedIn({ children = "已登录" }: { readonly children?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--ok-text)]">
      <Check size={12} weight="bold" />
      {children}
    </span>
  );
}

/**
 * The form to save a provider's API key.
 *
 * @remarks
 * Shared by first launch's second step and the settings (SPEC-0001, "首次启动 · 第 2 步"). An
 * empty key is not sent. Closes once the login it started succeeds.
 *
 * @sideEffects Starts a login through `flow`; calls `onClose` once saved or cancelled.
 * @param props - The flow, the providers to choose from, how to open an address, and what
 * closing does (no "取消" without it).
 * @returns The form.
 */
export function KeyForm({
  flow,
  candidates,
  openUrl,
  onClose,
}: {
  readonly flow: LoginFlow;
  readonly candidates: readonly SetupProvider[];
  readonly openUrl: (url: string) => void;
  readonly onClose?: () => void;
}) {
  const [providerId, setProviderId] = useState(candidates[0]?.providerId ?? "");
  const [key, setKey] = useState("");
  const [empty, setEmpty] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const { login } = flow;
  const mine =
    sent !== null && login !== null && login.loginId === flow.mine && login.method === "api_key" ? login : null;
  const done = mine?.state === "ok";
  useEffect(() => {
    if (done) onClose?.();
  }, [done, onClose]);
  return (
    <div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() === "") {
            setEmpty(true);
            return;
          }
          setEmpty(false);
          setSent(providerId);
          flow.start(providerId, "api_key", key.trim());
        }}
      >
        <select
          aria-label="服务商"
          className={`${FIELD} pr-7`}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {candidates.map((candidate) => (
            <option key={candidate.providerId} value={candidate.providerId}>
              {candidate.name}
            </option>
          ))}
        </select>
        <input
          aria-label="API Key"
          className={`${FIELD} flex-1 font-mono text-[length:var(--fs-sm)] ${empty ? "shadow-[inset_0_0_0_1px_var(--danger)]" : ""}`}
          type="password"
          placeholder="粘贴 API Key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button type="submit" className={PRIMARY_BUTTON} disabled={mine?.state === "running"}>
          保存
        </button>
        {onClose === undefined ? null : (
          <button type="button" className={GHOST_BUTTON} onClick={onClose}>
            取消
          </button>
        )}
      </form>
      <p className={`mt-2 text-[length:var(--fs-sm)] ${empty ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}`}>
        {empty ? "先粘贴 Key 再保存" : "粘贴后按回车或点“保存”"}
      </p>
      {mine === null ? null : <LoginDetails flow={flow} login={mine} openUrl={openUrl} />}
    </div>
  );
}

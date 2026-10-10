import { LoginError, type LoginRequest, type LoginRun, type LoginUpdate } from "@atrium/pi";
import { CommandError, type LoginFailureReason, type LoginUpdatedEvent } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { Logins } from "./logins";
import type { Toolbox } from "./toolbox";

/** Signing in and out through pi, as the commands ask (SPEC-0001, "首次启动 · 接口"). */
export interface LoginService {
  /**
   * Starts a login, cancelling the one under way.
   *
   * @throws {CommandError} `login_unavailable` when Atrium cannot sign in through pi now.
   */
  login(request: LoginRequest): Promise<{ loginId: string }>;
  /**
   * Answers one of pi's questions in the login under way.
   *
   * @throws {CommandError} `login_not_found` when `loginId` is not the login under way.
   */
  answer(loginId: string, promptId: number, value: string): void;
  /**
   * Cancels the login under way.
   *
   * @throws {CommandError} `login_not_found` when `loginId` is not the login under way.
   */
  cancel(loginId: string): void;
  /**
   * Removes a provider's stored credential.
   *
   * @throws {CommandError} `login_unavailable`, or `logout_failed` with pi's reason and words.
   */
  logout(providerId: string): Promise<void>;
  /** Cancels the login under way and waits for its program to go. */
  close(): Promise<void>;
}

/** A login the service started, and what it has shown of it. */
interface Login {
  readonly loginId: string;
  run: LoginRun | null;
  state: LoginUpdatedEvent;
  /** Set once pi gave an address that is not `https`; the login then ends failed. */
  insecure: boolean;
}

/**
 * Whether an address may be shown to the user and opened.
 *
 * @remarks
 * Only `https` (SPEC-0001, "首次启动 · 接口"): anything else from pi ends the login.
 *
 * @sideEffects none
 * @param url - The address.
 * @returns Whether it is `https`.
 */
function secure(url: string): boolean {
  return url.startsWith("https://");
}

/**
 * Creates the login service.
 *
 * @remarks
 * One login at a time: a new one cancels the one under way, and logins start in the order asked.
 * Each change to a login goes whole to every connection, so another window shows it too; only the
 * client that started it opens the address (SPEC-0001, "首次启动 · 接口"). An address or device code
 * page that is not `https` is never shown: the login is cancelled and ends failed. The log has the
 * provider, the method and the outcome, never the key, the addresses, the questions or pi's words
 * (security.md, "凭据与日志"). A login that ends signed in, and a logout that removes the
 * credential, call `credentialsChanged`, as the models pi can use may have changed.
 *
 * @sideEffects none until asked; then runs the login program and broadcasts.
 * @param options - Where the tools come from, the logins, how to reach every connection, what to do
 * once pi's credentials changed, how to make a login id, and the logger.
 * @returns The service.
 */
export function createLoginService(options: {
  readonly toolbox: Pick<Toolbox, "current">;
  readonly logins: Pick<Logins, "start" | "logout">;
  readonly broadcast: (event: LoginUpdatedEvent) => void;
  readonly credentialsChanged: () => void;
  readonly newId: () => string;
  readonly logger: Logger;
}): LoginService {
  let current: Login | null = null;
  let closed = false;
  /** The logins asked for, in order; each starts once the one before has. */
  let starting: Promise<unknown> = Promise.resolve();
  const finishing = new Set<Promise<void>>();

  /**
   * Changes a login's state and sends it to every connection.
   *
   * @remarks
   * See {@link createLoginService}.
   *
   * @sideEffects Broadcasts.
   * @param login - The login.
   * @param changes - What changed.
   */
  function publish(login: Login, changes: Partial<LoginUpdatedEvent>): void {
    login.state = { ...login.state, ...changes };
    options.broadcast(login.state);
  }

  /**
   * Gives up on a login because pi gave an address that is not `https`.
   *
   * @remarks
   * See {@link createLoginService}; the login ends failed once its program has gone.
   *
   * @sideEffects Cancels the login.
   * @param login - The login.
   */
  function refuse(login: Login): void {
    login.insecure = true;
    login.run?.cancel();
  }

  /**
   * Shows what pi told or asked in a login.
   *
   * @remarks
   * A notice counts as progress, without its links. Nothing more is shown once an address has
   * been refused.
   *
   * @sideEffects Broadcasts; may cancel the login.
   * @param login - The login.
   * @param update - What pi said.
   */
  function onUpdate(login: Login, update: LoginUpdate): void {
    if (login.insecure) return;
    if (update.kind === "prompt") {
      const { kind, message, placeholder, options: choices } = update.prompt;
      const question = { promptId: update.promptId, kind, message, placeholder, options: [...choices] };
      publish(login, { questions: [...login.state.questions, question] });
      return;
    }
    if (update.kind === "prompt_closed") {
      publish(login, { questions: login.state.questions.filter(({ promptId }) => promptId !== update.promptId) });
      return;
    }
    const { event } = update;
    switch (event.kind) {
      case "auth_url":
        if (!secure(event.url)) return refuse(login);
        return publish(login, { authUrl: { url: event.url, instructions: event.instructions } });
      case "device_code": {
        if (!secure(event.verificationUri)) return refuse(login);
        const { userCode, verificationUri, expiresInSeconds } = event;
        return publish(login, { deviceCode: { userCode, verificationUri, expiresInSeconds } });
      }
      case "progress":
      case "info":
        return publish(login, { progress: event.message });
    }
  }

  /**
   * Shows how a login ended, and logs it.
   *
   * @remarks
   * See {@link createLoginService}.
   *
   * @sideEffects Broadcasts; logs; forgets the login if it is the one under way.
   * @param login - The login.
   * @param outcome - How its program ended: `null` when the credential was saved, or the error.
   */
  function end(login: Login, outcome: unknown): void {
    let state: "ok" | "failed" | "cancelled" = "ok";
    let error: { reason: LoginFailureReason; detail: string | null } | null = null;
    if (login.insecure) {
      state = "failed";
      error = { reason: "insecure_url", detail: null };
    } else if (outcome instanceof LoginError) {
      const { reason, detail } = outcome;
      if (reason === "aborted") state = "cancelled";
      else {
        state = "failed";
        error = { reason, detail };
      }
    } else if (outcome !== null) {
      // The program's run only fails with a LoginError; anything else is a bug, shown as a failure.
      options.logger.error({ err: outcome }, "login ended unexpectedly");
      state = "failed";
      error = { reason: "failed", detail: null };
    }
    if (current === login) current = null;
    const { providerId, method } = login.state;
    options.logger.info({ providerId, method, state, reason: error?.reason ?? null }, "login finished");
    if (state === "ok") options.credentialsChanged();
    publish(login, { state, questions: [], error });
  }

  /**
   * Starts a login once the ones asked before have started.
   *
   * @remarks
   * See {@link createLoginService}.
   *
   * @sideEffects Cancels the login under way; runs the login program; broadcasts; logs.
   * @param request - What to sign in to.
   * @returns The new login's id.
   * @throws {CommandError} `login_unavailable` when Atrium cannot sign in through pi now.
   */
  async function begin(request: LoginRequest): Promise<{ loginId: string }> {
    current?.run?.cancel();
    const tools = await options.toolbox.current();
    if (closed) throw new CommandError("login_unavailable");
    const login: Login = {
      loginId: options.newId(),
      run: null,
      insecure: false,
      state: {
        type: "login_updated",
        loginId: "",
        providerId: request.providerId,
        method: request.method,
        state: "running",
        authUrl: null,
        deviceCode: null,
        questions: [],
        progress: null,
        error: null,
      },
    };
    login.state = { ...login.state, loginId: login.loginId };
    const run = await options.logins.start(tools, request, (update) => onUpdate(login, update));
    if (run === null) throw new CommandError("login_unavailable");
    login.run = run;
    current = login;
    options.logger.info({ providerId: request.providerId, method: request.method }, "login started");
    options.broadcast(login.state);
    const done = run.finished.then(
      () => end(login, null),
      (error: unknown) => end(login, error),
    );
    finishing.add(done);
    void done.finally(() => finishing.delete(done));
    if (closed) run.cancel();
    return { loginId: login.loginId };
  }

  /**
   * The login under way with this id, and its run.
   *
   * @remarks
   * See {@link LoginService.answer}.
   *
   * @sideEffects none
   * @param loginId - The id.
   * @returns The login and its run.
   * @throws {CommandError} `login_not_found` when it is not the login under way.
   */
  function running(loginId: string): { login: Login; run: LoginRun } {
    if (current?.loginId !== loginId || current.run === null) throw new CommandError("login_not_found");
    return { login: current, run: current.run };
  }

  return {
    login(request) {
      const started = starting.then(() => begin(request));
      starting = started.catch(() => undefined);
      return started;
    },
    answer(loginId, promptId, value) {
      const { login, run } = running(loginId);
      run.answer(promptId, value);
      // pi closes only the questions it withdraws; an answered one is no longer asked.
      const questions = login.state.questions.filter((question) => question.promptId !== promptId);
      if (questions.length !== login.state.questions.length) publish(login, { questions });
    },
    cancel: (loginId) => running(loginId).run.cancel(),
    async logout(providerId) {
      const tools = await options.toolbox.current();
      let done: boolean;
      try {
        done = await options.logins.logout(tools, providerId);
      } catch (error) {
        if (!(error instanceof LoginError)) throw error;
        options.logger.warn({ providerId, reason: error.reason }, "logout failed");
        throw new CommandError("logout_failed", { reason: error.reason, detail: error.detail });
      }
      if (!done) throw new CommandError("login_unavailable");
      options.logger.info({ providerId }, "logged out");
      options.credentialsChanged();
    },
    async close() {
      closed = true;
      await starting;
      current?.run?.cancel();
      await Promise.allSettled(finishing);
    },
  };
}

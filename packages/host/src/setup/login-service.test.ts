import { CommandError, type LoginUpdatedEvent } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIN_WORKER, fakePiTools } from "../../test/fake-pi-tools";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { createPiDeps } from "../platform/pi-deps";
import { type LoginService, createLoginService } from "./login-service";
import { createLogins } from "./logins";
import type { HostTools } from "./toolbox";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A login service over a fake pi in a scenario, sending its events into an array.
 *
 * @remarks
 * The logins are real: the login program runs and loads the fake pi package. Login ids count up
 * from `l1`. Resources are counted so a test can see the program is gone.
 *
 * @sideEffects Creates a temporary directory; closes the service and removes the directory after
 * the test.
 * @param scenario - What the fake pi does, or `null` for no tools.
 * @returns The service, its events, the log records and the open login programs.
 */
async function service(scenario: string | null): Promise<{
  service: LoginService;
  events: LoginUpdatedEvent[];
  records: Record<string, unknown>[];
  open: () => number;
  changed: () => number;
}> {
  let tools: HostTools | null = null;
  if (scenario !== null) {
    const fake = await fakePiTools(scenario);
    cleanups.push(fake.cleanup);
    tools = fake.tools;
  }
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  const logins = createLogins({
    worker: LOGIN_WORKER,
    deps: (env) => createPiDeps({ clock: systemClock, resources: recording.resources, logger: recording.logger, env }),
    logger: recording.logger,
  });
  cleanups.push(() => logins.close());
  const events: LoginUpdatedEvent[] = [];
  let ids = 0;
  let changed = 0;
  const value = createLoginService({
    toolbox: { current: async () => tools },
    logins,
    broadcast: (event) => events.push(event),
    credentialsChanged: () => (changed += 1),
    newId: () => `l${++ids}`,
    logger: recording.logger,
  });
  cleanups.push(() => value.close());
  return {
    service: value,
    events,
    records: recording.records,
    open: () => recording.resources.snapshot()["pi-login"] ?? 0,
    changed: () => changed,
  };
}

/**
 * Waits for an event that matches.
 *
 * @remarks
 * The login program takes a moment to start and load pi.
 *
 * @sideEffects none
 * @param events - The events so far.
 * @param matches - What the event must have.
 * @returns The first event that matches.
 */
async function until(
  events: readonly LoginUpdatedEvent[],
  matches: (event: LoginUpdatedEvent) => boolean,
): Promise<LoginUpdatedEvent> {
  return vi.waitFor(
    () => {
      const found = events.find(matches);
      if (found === undefined) throw new Error("not yet");
      return found;
    },
    { timeout: 10_000 },
  );
}

/**
 * The id of the first question a login shows.
 *
 * @remarks
 * Fails the test when there is none.
 *
 * @sideEffects none
 * @param event - The login's state.
 * @returns The question's id.
 */
function firstPrompt(event: LoginUpdatedEvent): number {
  return present(event.questions[0], "a question").promptId;
}

/**
 * Whether an event is the end of a login.
 *
 * @remarks
 * For {@link until}.
 *
 * @sideEffects none
 * @param loginId - The login.
 * @returns The test.
 */
function endOf(loginId: string): (event: LoginUpdatedEvent) => boolean {
  return (event) => event.loginId === loginId && event.state !== "running";
}

/**
 * Whether an event shows a login waiting, as the `patient` fake pi says once it has started.
 *
 * @remarks
 * For {@link until}.
 *
 * @sideEffects none
 * @param loginId - The login.
 * @returns The test.
 */
function waitingIn(loginId: string): (event: LoginUpdatedEvent) => boolean {
  return (event) => event.loginId === loginId && event.progress === "Waiting";
}

/** The state of a login as it starts, before pi has said anything. */
const STARTED = {
  type: "login_updated",
  authUrl: null,
  deviceCode: null,
  questions: [],
  progress: null,
  error: null,
} as const;

describe("LoginService.login", () => {
  it("shows what pi tells and asks, takes the answers, and ends signed in", async () => {
    const { service: logins, events, open, changed } = await service("complete");

    const { loginId } = await logins.login({ providerId: "acme", method: "oauth" });
    const asked = await until(events, (event) => event.questions.length > 0);
    logins.answer(loginId, firstPrompt(asked), "b");
    const second = await until(events, (event) => event.questions.some(({ message }) => message === "Code?"));
    logins.answer(loginId, firstPrompt(second), "42");
    const done = await until(events, (event) => event.state !== "running");

    expect(loginId).toBe("l1");
    expect(events[0]).toStrictEqual({
      ...STARTED,
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "running",
    });
    expect(asked).toStrictEqual({
      ...STARTED,
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "running",
      authUrl: { url: "https://acme.test/authorize", instructions: null },
      deviceCode: { userCode: "WXYZ", verificationUri: "https://acme.test/d", expiresInSeconds: null },
      questions: [
        {
          promptId: firstPrompt(asked),
          kind: "select",
          message: "Which?",
          placeholder: null,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
      progress: "No links",
    });
    expect(events).toContainEqual(expect.objectContaining({ progress: "Read this" }));
    expect(events).toContainEqual({ ...asked, questions: [] });
    expect(second.questions).toStrictEqual([
      { promptId: firstPrompt(second), kind: "text", message: "Code?", placeholder: "123", options: [] },
    ]);
    expect(done).toStrictEqual({ ...asked, state: "ok", questions: [] });
    expect(events.at(-1)).toBe(done);
    expect(changed()).toBe(1);
    await vi.waitFor(() => expect(open()).toBe(0));
  });

  it("gives the key to pi's first secret question and shows the others", async () => {
    const { service: logins, events } = await service("api-key");

    const { loginId } = await logins.login({ providerId: "acme", method: "api_key", key: "sk-1" });
    const account = await until(events, (event) => event.questions.length > 0);
    logins.answer(loginId, firstPrompt(account), "acct");
    const again = await until(events, (event) => event.questions.some(({ message }) => message === "Again?"));
    logins.answer(loginId, firstPrompt(again), "sk-1");
    const done = await until(events, (event) => event.state !== "running");

    expect(account.questions.map(({ kind, message }) => [kind, message])).toStrictEqual([["text", "Account?"]]);
    expect(again.questions.map(({ kind, message }) => [kind, message])).toStrictEqual([["secret", "Again?"]]);
    expect(events.some((event) => event.questions.some(({ message }) => message === "Key?"))).toBe(false);
    expect(done).toMatchObject({ method: "api_key", state: "ok", error: null });
  });

  it("ends failed with pi's words, and logs only the provider, the method and the reason", async () => {
    const { service: logins, events, records, changed } = await service("fail");

    await logins.login({ providerId: "acme", method: "api_key", key: "sk-secret-1" });
    const done = await until(events, (event) => event.state !== "running");

    expect(done).toStrictEqual({
      ...STARTED,
      loginId: "l1",
      providerId: "acme",
      method: "api_key",
      state: "failed",
      error: { reason: "failed", detail: "token exchange failed: 400" },
    });
    await vi.waitFor(() =>
      expect(records).toContainEqual(
        expect.objectContaining({ msg: "login finished", providerId: "acme", state: "failed", reason: "failed" }),
      ),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "login started", providerId: "acme", method: "api_key" }),
    );
    expect(JSON.stringify(records)).not.toContain("sk-secret-1");
    expect(JSON.stringify(records)).not.toContain("token exchange");
    expect(changed()).toBe(0);
  });

  it.each([
    ["sign-in address", "insecure"],
    ["device code page", "insecure-device"],
  ])("ends failed, without showing it, when pi gives a %s that is not https", async (_what, scenario) => {
    const { service: logins, events, open } = await service(scenario);

    await logins.login({ providerId: "acme", method: "oauth" });
    const done = await until(events, (event) => event.state !== "running");

    expect(done).toStrictEqual({
      ...STARTED,
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "failed",
      error: { reason: "insecure_url", detail: null },
    });
    expect(events.map(({ authUrl, deviceCode }) => [authUrl, deviceCode])).toStrictEqual(
      events.map(() => [null, null]),
    );
    await vi.waitFor(() => expect(open()).toBe(0));
    expect(events.at(-1)).toBe(done);
  });

  it("is cancelled when asked, and the program goes", async () => {
    const { service: logins, events, open, changed } = await service("patient");
    const { loginId } = await logins.login({ providerId: "acme", method: "oauth" });
    await until(events, (event) => event.progress === "Waiting");

    logins.cancel(loginId);
    const done = await until(events, (event) => event.state !== "running");

    expect(done).toMatchObject({ loginId: "l1", state: "cancelled", progress: "Waiting", error: null });
    expect(changed()).toBe(0);
    await vi.waitFor(() => expect(open()).toBe(0));
  });

  it("cancels the login under way when another starts", async () => {
    const { service: logins, events } = await service("patient");
    await logins.login({ providerId: "acme", method: "oauth" });
    await until(events, (event) => event.progress === "Waiting");

    const { loginId } = await logins.login({ providerId: "beta", method: "oauth" });
    const first = await until(events, endOf("l1"));
    await until(events, waitingIn("l2"));

    expect(loginId).toBe("l2");
    expect(first.state).toBe("cancelled");
    expect(events.filter((event) => event.loginId === "l2").map(({ state }) => state)).not.toContain("cancelled");
  });

  it("knows no login but the one under way", async () => {
    const { service: logins, events } = await service("fail");
    const { loginId } = await logins.login({ providerId: "acme", method: "oauth" });
    await until(events, (event) => event.state !== "running");

    const notFound = new CommandError("login_not_found");
    expect(() => logins.answer("l9", 0, "x")).toThrow(notFound);
    expect(() => logins.cancel("l9")).toThrow(notFound);
    expect(() => logins.answer(loginId, 0, "x")).toThrow(notFound);
    expect(() => logins.cancel(loginId)).toThrow(notFound);
  });

  it("is unavailable without tools", async () => {
    const { service: logins, events } = await service(null);

    await expect(logins.login({ providerId: "acme", method: "oauth" })).rejects.toThrow(
      new CommandError("login_unavailable"),
    );
    await expect(logins.logout("acme")).rejects.toThrow(new CommandError("login_unavailable"));
    expect(events).toStrictEqual([]);
  });

  it("cancels the login under way on close and waits for the program to go", async () => {
    const { service: logins, events, open } = await service("patient");
    await logins.login({ providerId: "acme", method: "oauth" });
    await until(events, (event) => event.progress === "Waiting");

    await logins.close();

    expect(open()).toBe(0);
    expect(events.at(-1)).toMatchObject({ state: "cancelled" });
  });
});

describe("LoginService.logout", () => {
  it("removes the credential through pi", async () => {
    const { service: logins, changed } = await service("status");

    await expect(logins.logout("acme")).resolves.toBeUndefined();
    expect(changed()).toBe(1);
  });

  it("fails with pi's words when pi refuses", async () => {
    const { service: logins, changed } = await service("logout-fails");

    const failing = logins.logout("acme");

    await expect(failing).rejects.toBeInstanceOf(CommandError);
    await expect(failing).rejects.toMatchObject({
      code: "logout_failed",
      params: { reason: "failed", detail: "locked acme" },
    });
    expect(changed()).toBe(0);
  });
});

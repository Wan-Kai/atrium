import type { Turn } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import {
  TITLE_INSTRUCTIONS,
  type TitleSubject,
  cleanTitle,
  createTitleGenerator,
  firstExchange,
  titleInput,
} from "./titles";

/**
 * A finished turn with a user message and these steps.
 *
 * @remarks
 * Only the user's text and the steps matter to titles.
 *
 * @sideEffects none
 * @param text - The user's text.
 * @param steps - The turn's steps.
 * @returns The turn.
 */
function turn(text: string, steps: Turn["steps"]): Turn {
  return {
    kind: "turn",
    id: "t1",
    user: { text, images: 0, clientMessageId: null, auto: false, timestamp: 1 },
    steps,
    outcome: "done",
    error: null,
    startedAt: 1,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

describe("titleInput", () => {
  it("gives the user's text and the reply, labelled", () => {
    expect(titleInput("fix the login bug", "Fixed it.")).toBe("User:\nfix the login bug\n\nAssistant:\nFixed it.");
  });

  it("leaves out an empty reply", () => {
    expect(titleInput("fix the login bug", "")).toBe("User:\nfix the login bug");
  });

  it("keeps at most 1200 characters of the user's text and 2000 in all, by character", () => {
    const input = titleInput("用".repeat(1500), "😀".repeat(1000));

    expect(input).toBe(`User:\n${"用".repeat(1200)}\n\nAssistant:\n${"😀".repeat(800)}`);
  });

  it("gives a short user text's room to the reply", () => {
    const input = titleInput("u".repeat(100), "r".repeat(3000));

    expect(input).toBe(`User:\n${"u".repeat(100)}\n\nAssistant:\n${"r".repeat(1900)}`);
  });
});

describe("TITLE_INSTRUCTIONS", () => {
  it("asks for a short title in the user's language, without punctuation or quotes, and nothing else", () => {
    expect(TITLE_INSTRUCTIONS).toBe(
      "Write a title for the conversation you are given. Use the language of the user's message. " +
        "Keep it short: at most 16 characters in Chinese, Japanese or Korean, at most 6 words otherwise. " +
        "No punctuation, no quotes. Output the title only.",
    );
  });
});

describe("cleanTitle", () => {
  it.each([
    ["登录修复", "登录修复"],
    ["  Login fix  \nbecause the user asked", "Login fix"],
    ["\n\nLogin fix", "Login fix"],
    ['"Login fix"', "Login fix"],
    ["“登录修复”", "登录修复"],
    ["「登录修复」", "登录修复"],
    ["『登录修复』", "登录修复"],
    ["《登录修复》", "登录修复"],
    ["‘Login fix’", "Login fix"],
    ["'Login fix'", "Login fix"],
    ["`Login fix`", "Login fix"],
    ['"“Login fix”"', "Login fix"],
    ['"Login fix', '"Login fix'],
    ['Login fix"', 'Login fix"'],
    ['" Login fix "', "Login fix"],
    ["登录修复。", "登录修复"],
    ["Login fix...", "Login fix"],
    ["Why login fails?!", "Why login fails"],
    ["修复，；：、！？…", "修复"],
    ['"Login fix."', "Login fix"],
    ["Node.js", "Node.js"],
    ["x".repeat(60), "x".repeat(50)],
    ["😀".repeat(60), "😀".repeat(50)],
  ])("makes %j into %j", (raw, title) => {
    expect(cleanTitle(raw)).toBe(title);
  });

  it.each(["", "   ", '""', '"', "。", "“”"])("finds no title in %j", (raw) => {
    expect(cleanTitle(raw)).toBeNull();
  });
});

describe("firstExchange", () => {
  it("takes the first turn's text and the last text of its reply", () => {
    const items = [
      { kind: "notice", id: "n1", notice: "restarted", attempt: 1, timestamp: 1 } as const,
      turn("fix the login bug", [
        { kind: "text", id: "s1", text: "Looking." },
        {
          kind: "tool",
          id: "s2",
          callId: "c",
          tool: "bash",
          args: {},
          status: "done",
          output: "",
          details: null,
          partial: false,
        },
        { kind: "text", id: "s3", text: "Fixed it." },
        { kind: "thinking", id: "s4", text: "done", durationMs: null },
      ]),
      turn("later", [{ kind: "text", id: "s1", text: "Later." }]),
    ];

    expect(firstExchange(items)).toStrictEqual({ user: "fix the login bug", reply: "Fixed it." });
  });

  it("gives an empty reply when the turn has no text", () => {
    expect(firstExchange([turn("fix it", [])])).toStrictEqual({ user: "fix it", reply: "" });
  });

  it.each([
    ["no turn", []],
    ["a first turn without text", [turn("  ", []), turn("later", [])]],
  ])("finds nothing with %s", (_, items) => {
    expect(firstExchange(items)).toBeNull();
  });
});

/**
 * A generator whose one-shot calls the test answers, over subjects it sets.
 *
 * @remarks
 * Each call waits until the test settles it, so a test can act while a title is being made.
 *
 * @sideEffects none
 * @returns The generator, the subjects, the calls, the titles written and the log records.
 */
function generator() {
  const recording = recordingTracing();
  const subjects = new Map<string, TitleSubject>();
  const calls: {
    readonly request: unknown;
    readonly signal: AbortSignal;
    readonly answer: PromiseWithResolvers<string>;
  }[] = [];
  const written: [string, string][] = [];
  /** A subject that writes to `written`, and may refuse to. */
  const subject = (sessionId: string, accept = true): TitleSubject => ({
    cwd: `/work/${sessionId}`,
    model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    input: `User:\n${sessionId}`,
    write: (title) => {
      if (accept) written.push([sessionId, title]);
      return Promise.resolve(accept);
    },
  });
  const titles = createTitleGenerator({
    subject: (sessionId) => subjects.get(sessionId) ?? null,
    oneShot: (request, signal) => {
      const answer = Promise.withResolvers<string>();
      calls.push({ request, signal, answer });
      return answer.promise;
    },
    logger: recording.logger,
  });
  /** The log records the generator wrote. */
  const logs = () => recording.records.map(({ msg, sessionId, reason }) => ({ msg, sessionId, reason }));
  return { titles, subjects, subject, calls, written, logs };
}

describe("TitleGenerator", () => {
  it("asks for a title in the session's directory, on its model, with the instructions, and writes it cleaned", async () => {
    const { titles, subjects, subject, calls, written, logs } = generator();
    subjects.set("s1", subject("s1"));

    titles.settled("s1");
    calls[0]?.answer.resolve(" “登录修复”。\nmore");
    await vi.waitFor(() => expect(written).toStrictEqual([["s1", "登录修复"]]));

    expect(calls.map(({ request }) => request)).toStrictEqual([
      {
        cwd: "/work/s1",
        model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
        systemPrompt: TITLE_INSTRUCTIONS,
        input: "User:\ns1",
      },
    ]);
    expect(logs()).toStrictEqual([]);
  });

  it("asks for nothing without a subject, and once at a time per session", async () => {
    const { titles, subjects, subject, calls, written } = generator();
    titles.settled("none");
    subjects.set("s1", subject("s1"));
    subjects.set("s2", subject("s2"));

    titles.settled("s1");
    titles.settled("s1");
    titles.settled("s2");
    calls[0]?.answer.resolve("One");
    await vi.waitFor(() => expect(written).toHaveLength(1));
    titles.settled("s1");

    expect(calls.map(({ request }) => (request as { cwd: string }).cwd)).toStrictEqual([
      "/work/s1",
      "/work/s2",
      "/work/s1",
    ]);
  });

  it.each([
    ["the call failed", (answer: PromiseWithResolvers<string>) => answer.reject(new Error("model_failed")), "failed"],
    ["the title was empty", (answer: PromiseWithResolvers<string>) => answer.resolve("“”"), "empty"],
  ])("logs only why when %s, and tries again on the next run's end", async (_, settle, reason) => {
    const { titles, subjects, subject, calls, written, logs } = generator();
    subjects.set("s1", subject("s1"));

    titles.settled("s1");
    settle(present(calls[0], "the call").answer);
    await vi.waitFor(() => expect(logs()).toHaveLength(1));
    titles.settled("s1");

    expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason }]);
    expect(calls).toHaveLength(2);
    expect(written).toStrictEqual([]);
  });

  it("logs only why when the title could not be written", async () => {
    const { titles, subjects, subject, calls, logs } = generator();
    subjects.set("s1", { ...subject("s1"), write: () => Promise.reject(new Error("secret-in-pi-text")) });

    titles.settled("s1");
    calls[0]?.answer.resolve("Login fix");

    await vi.waitFor(() =>
      expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason: "unwritten" }]),
    );
  });

  it("logs a title the session no longer takes as discarded", async () => {
    const { titles, subjects, subject, calls, logs } = generator();
    subjects.set("s1", subject("s1", false));

    titles.settled("s1");
    calls[0]?.answer.resolve("Login fix");

    await vi.waitFor(() =>
      expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason: "discarded" }]),
    );
  });

  it("calls off the titles being made when closed, and makes no more", async () => {
    const { titles, subjects, subject, calls, written, logs } = generator();
    subjects.set("s1", subject("s1"));
    titles.settled("s1");

    const closing = titles.close();
    const aborted = calls[0]?.signal.aborted;
    calls[0]?.answer.reject(new Error("aborted"));
    await closing;
    titles.settled("s1");

    expect(aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(written).toStrictEqual([]);
    expect(logs()).toStrictEqual([]);
  });
});

import type { ModelRef, Turn } from "@atrium/protocol";
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
  titleModelLookup,
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
    source: null,
    user: { text, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 1 },
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
 * @param titleModel - The title model pi can use in a directory, as the generator is told.
 * @returns The generator, the subjects, the calls, the titles written and the log records.
 */
function generator(titleModel: (cwd: string) => Promise<ModelRef | null> = async () => null) {
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
    titleModel,
    oneShot: (request, signal) => {
      const answer = Promise.withResolvers<string>();
      calls.push({ request, signal, answer });
      return answer.promise;
    },
    logger: recording.logger,
  });
  /** The log records the generator wrote. */
  const logs = () => recording.records.map(({ msg, sessionId, reason }) => ({ msg, sessionId, reason }));
  /** Waits for the `n`th one-shot call, which starts once the title model is known. */
  const call = (n: number) => vi.waitFor(() => present(calls[n], `call ${n}`));
  return { titles, subjects, subject, calls, call, written, logs };
}

/** The title model chosen in the settings. */
const CHOSEN = { providerId: "openai", modelId: "gpt-5-mini" };

/**
 * The chosen title model if pi can use it in a directory, as the generator is told.
 *
 * @remarks
 * pi can use it in `/work/usable`, not in `/work/unusable`; `/work/broken` cannot be told.
 *
 * @sideEffects none
 * @param cwd - The directory.
 * @returns The model, or `null`.
 * @throws {Error} For `/work/broken`.
 */
async function titleModelIn(cwd: string): Promise<ModelRef | null> {
  if (cwd === "/work/broken") throw new Error("pi_unavailable");
  return cwd === "/work/usable" ? CHOSEN : null;
}

/**
 * The models pi lists in a directory, as the title model lookup is told.
 *
 * @remarks
 * Only `/work/app` lists the chosen title model.
 *
 * @sideEffects none
 * @param dir - The directory.
 * @returns The list.
 */
function modelsIn(dir: string): { models: ModelRef[] } {
  return { models: dir === "/work/app" ? [CHOSEN] : [{ providerId: "openai", modelId: "gpt-5" }] };
}

describe("titleModelLookup", () => {
  it("gives the chosen title model where pi lists it, asking for chats where the model panel does", async () => {
    const listed: string[] = [];
    const lookup = titleModelLookup({
      chosen: () => CHOSEN,
      list: async (dir) => {
        listed.push(dir);
        return modelsIn(dir);
      },
      chatsRoot: "/home/.atrium/chats",
      chatsDir: "/home/.atrium",
    });

    expect(await lookup("/work/app")).toStrictEqual(CHOSEN);
    expect(await lookup("/work/lib")).toBeNull();
    expect(await lookup("/home/.atrium/chats/c1")).toBeNull();
    expect(await lookup("/home/.atrium/chats-old")).toBeNull();
    expect(listed).toStrictEqual(["/work/app", "/work/lib", "/home/.atrium", "/home/.atrium/chats-old"]);
  });

  it("gives none, asking pi nothing, when no title model is chosen", async () => {
    const listed: string[] = [];
    const lookup = titleModelLookup({
      chosen: () => null,
      list: async (dir) => {
        listed.push(dir);
        return { models: [CHOSEN] };
      },
      chatsRoot: "/home/.atrium/chats",
      chatsDir: "/home/.atrium",
    });

    expect(await lookup("/work/app")).toBeNull();
    expect(listed).toStrictEqual([]);
  });

  it("matches the provider and the model both", async () => {
    const lookup = titleModelLookup({
      chosen: () => CHOSEN,
      list: async () => ({
        models: [
          { providerId: "azure", modelId: CHOSEN.modelId },
          { providerId: CHOSEN.providerId, modelId: "gpt-5" },
        ],
      }),
      chatsRoot: "/c",
      chatsDir: "/",
    });

    expect(await lookup("/work/app")).toBeNull();
  });
});

describe("TitleGenerator", () => {
  it("asks for a title in the session's directory, on its model, with the instructions, and writes it cleaned", async () => {
    const { titles, subjects, subject, calls, call, written, logs } = generator();
    subjects.set("s1", subject("s1"));

    titles.settled("s1");
    (await call(0)).answer.resolve(" “登录修复”。\nmore");
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

  it("asks on the title model pi can use in the session's directory, else on the session's own", async () => {
    const { titles, subjects, subject, calls } = generator(titleModelIn);
    for (const sessionId of ["usable", "unusable", "broken"]) subjects.set(sessionId, subject(sessionId));

    for (const sessionId of ["usable", "unusable", "broken"]) titles.settled(sessionId);
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls.map(({ request }) => (request as { model: ModelRef }).model)).toStrictEqual([
      CHOSEN,
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ]);
  });

  it("asks for nothing without a subject, and once at a time per session", async () => {
    const { titles, subjects, subject, calls, call, written } = generator();
    titles.settled("none");
    subjects.set("s1", subject("s1"));
    subjects.set("s2", subject("s2"));

    titles.settled("s1");
    titles.settled("s1");
    titles.settled("s2");
    (await call(0)).answer.resolve("One");
    await vi.waitFor(() => expect(written).toHaveLength(1));
    titles.settled("s1");
    await call(2);

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
    const { titles, subjects, subject, calls, call, written, logs } = generator();
    subjects.set("s1", subject("s1"));

    titles.settled("s1");
    settle((await call(0)).answer);
    await vi.waitFor(() => expect(logs()).toHaveLength(1));
    titles.settled("s1");
    await call(1);

    expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason }]);
    expect(calls).toHaveLength(2);
    expect(written).toStrictEqual([]);
  });

  it("logs only why when the title could not be written", async () => {
    const { titles, subjects, subject, call, logs } = generator();
    subjects.set("s1", { ...subject("s1"), write: () => Promise.reject(new Error("secret-in-pi-text")) });

    titles.settled("s1");
    (await call(0)).answer.resolve("Login fix");

    await vi.waitFor(() =>
      expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason: "unwritten" }]),
    );
  });

  it("logs a title the session no longer takes as discarded", async () => {
    const { titles, subjects, subject, call, logs } = generator();
    subjects.set("s1", subject("s1", false));

    titles.settled("s1");
    (await call(0)).answer.resolve("Login fix");

    await vi.waitFor(() =>
      expect(logs()).toStrictEqual([{ msg: "session title not made", sessionId: "s1", reason: "discarded" }]),
    );
  });

  it("starts no call when closed while the title model is looked up", async () => {
    const looking = Promise.withResolvers<ModelRef | null>();
    const { titles, subjects, subject, calls, written, logs } = generator(() => looking.promise);
    subjects.set("s1", subject("s1"));
    titles.settled("s1");

    const closing = titles.close();
    looking.resolve(null);
    await closing;

    expect(calls).toStrictEqual([]);
    expect(written).toStrictEqual([]);
    expect(logs()).toStrictEqual([]);
  });

  it("calls off the titles being made when closed, and makes no more", async () => {
    const { titles, subjects, subject, calls, call, written, logs } = generator();
    subjects.set("s1", subject("s1"));
    titles.settled("s1");
    const first = await call(0);

    const closing = titles.close();
    const aborted = first.signal.aborted;
    first.answer.reject(new Error("aborted"));
    await closing;
    titles.settled("s1");

    expect(aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(written).toStrictEqual([]);
    expect(logs()).toStrictEqual([]);
  });
});

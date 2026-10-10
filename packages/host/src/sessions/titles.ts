import type { ModelRef, TranscriptItem } from "@atrium/protocol";
import type { Logger } from "../platform/logger";

/** What the model is told to do with the conversation (SPEC-0001, "自动生成标题"). */
export const TITLE_INSTRUCTIONS =
  "Write a title for the conversation you are given. Use the language of the user's message. " +
  "Keep it short: at most 16 characters in Chinese, Japanese or Korean, at most 6 words otherwise. " +
  "No punctuation, no quotes. Output the title only.";

/** The most characters of the conversation the model is given. */
const INPUT_LIMIT = 2000;

/** The most of them the user's message may take. */
const USER_LIMIT = 1200;

/** The longest title kept, in characters. */
const TITLE_LIMIT = 50;

/** Quotes a title may come wrapped in, opening and closing. */
const QUOTES: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
];

/** Punctuation and spaces a title may end with. */
const TRAILING = /[\s.,;:!?…。，、；：！？]+$/u;

/**
 * The first characters of a text, whole characters only.
 *
 * @remarks
 * Counted by code point, so an emoji is never cut in half.
 *
 * @sideEffects none
 * @param text - The text.
 * @param limit - How many characters.
 * @returns The beginning.
 */
function head(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

/**
 * What the model is given to name a conversation: the user's first message and the reply.
 *
 * @remarks
 * SPEC-0001 ("自动生成标题"): at most 2000 characters, the user's text at most 1200 of them; the
 * reply has the rest. Only the content counts, not the labels.
 *
 * @sideEffects none
 * @param user - The first message's text.
 * @param reply - The reply's text, or empty.
 * @returns The input.
 */
export function titleInput(user: string, reply: string): string {
  const asked = head(user, USER_LIMIT);
  const answered = head(reply, INPUT_LIMIT - Array.from(asked).length);
  return answered === "" ? `User:\n${asked}` : `User:\n${asked}\n\nAssistant:\n${answered}`;
}

/**
 * Tidies the model's answer into a title.
 *
 * @remarks
 * SPEC-0001 ("自动生成标题"): models do not always follow the instructions, so the host takes the
 * first line, drops quotes around it and punctuation at its end, and keeps at most 50 characters.
 * A quote alone is no title.
 *
 * @sideEffects none
 * @param raw - The model's answer.
 * @returns The title, or `null` when nothing is left.
 */
export function cleanTitle(raw: string): string | null {
  // Stryker disable next-line StringLiteral: splitting always gives at least one part.
  let title = raw.trim().split("\n", 1)[0] ?? "";
  for (let unwrapped = true; unwrapped;) {
    title = title.replace(TRAILING, "");
    const pair = QUOTES.find(([open, close]) => title.startsWith(open) && title.endsWith(close));
    unwrapped = pair !== undefined;
    if (pair !== undefined) title = title.slice(pair[0].length, -pair[1].length).trim();
  }
  title = head(title, TITLE_LIMIT);
  return title === "" ? null : title;
}

/**
 * The text of a session's first turn and of its reply.
 *
 * @remarks
 * The reply is the turn's last text, which comes after its tools (SPEC-0001, "自动生成标题"). A
 * first turn without text, such as one with only an image, gives nothing to name.
 *
 * @sideEffects none
 * @param items - The session's items from its start.
 * @returns The texts, or `null`.
 */
export function firstExchange(
  items: readonly TranscriptItem[],
): { readonly user: string; readonly reply: string } | null {
  const first = items.find((item) => item.kind === "turn");
  if (first === undefined || first.user.text.trim() === "") return null;
  const reply = first.steps.findLast((step) => step.kind === "text");
  return { user: first.user.text, reply: reply?.text ?? "" };
}

/** A session that may be given a title, and how to give it one. */
export interface TitleSubject {
  readonly cwd: string;
  readonly model: ModelRef;
  /** The conversation, from `titleInput`. */
  readonly input: string;
  /** Writes the title, unless the session no longer takes one; answers whether it did. */
  write(title: string): Promise<boolean>;
}

/** What a one-shot call is asked. */
export interface TitleRequest {
  readonly cwd: string;
  readonly model: ModelRef;
  readonly systemPrompt: string;
  readonly input: string;
}

/** Gives sessions titles when their runs end. */
export interface TitleGenerator {
  /** A session's run ended; makes it a title if it needs one and none is being made. */
  settled(sessionId: string): void;
  /** Calls off the titles being made; resolves once they have ended. */
  close(): Promise<void>;
}

/**
 * Creates the title generator.
 *
 * @remarks
 * SPEC-0001 ("自动生成标题"): `subject` decides whether a session needs a title, and `write`
 * whether it still takes one when it comes, so the manager keeps those rules; this module asks,
 * tidies and keeps one call per session. A failure is only logged, by reason, and the next run's
 * end tries again; content never reaches the log.
 *
 * @sideEffects none until `settled`; then runs one-shot calls and writes titles.
 * @param options - Which sessions need a title, the one-shot call, and the logger.
 * @returns The generator.
 */
export function createTitleGenerator(options: {
  readonly subject: (sessionId: string) => TitleSubject | null;
  readonly oneShot: (request: TitleRequest, signal: AbortSignal) => Promise<string>;
  readonly logger: Logger;
}): TitleGenerator {
  const making = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>();
  let closed = false;

  /**
   * Makes one session's title.
   *
   * @remarks
   * See `createTitleGenerator`. A call cancelled by `close` is not a failure.
   *
   * @sideEffects Runs a one-shot call; writes the title; logs a failure.
   * @param sessionId - The session.
   * @param subject - The session, as it is now.
   * @param signal - Aborted by `close`.
   */
  async function make(sessionId: string, subject: TitleSubject, signal: AbortSignal): Promise<void> {
    /**
     * Logs why no title came of it.
     *
     * @remarks
     * A call cancelled by `close` is not logged.
     *
     * @sideEffects Logs.
     * @param reason - Why.
     */
    const fail = (reason: "failed" | "empty" | "unwritten" | "discarded"): void => {
      if (!signal.aborted) options.logger.info({ sessionId, reason }, "session title not made");
    };
    const { cwd, model, input } = subject;
    const answer = await options
      .oneShot({ cwd, model, systemPrompt: TITLE_INSTRUCTIONS, input }, signal)
      .catch(() => null);
    if (answer === null) return fail("failed");
    const title = cleanTitle(answer);
    if (title === null) return fail("empty");
    // pi's error text may quote the session, so only the reason is logged.
    const wrote = await subject.write(title).catch(() => null);
    if (wrote === null) return fail("unwritten");
    if (!wrote) fail("discarded");
  }

  return {
    settled(sessionId) {
      if (closed || making.has(sessionId)) return;
      const subject = options.subject(sessionId);
      if (subject === null) return;
      const controller = new AbortController();
      // `make` handles its own failures.
      const done = make(sessionId, subject, controller.signal).finally(() => making.delete(sessionId));
      making.set(sessionId, { controller, done });
    },
    async close() {
      closed = true;
      for (const { controller } of making.values()) controller.abort();
      await Promise.all([...making.values()].map(({ done }) => done));
    },
  };
}

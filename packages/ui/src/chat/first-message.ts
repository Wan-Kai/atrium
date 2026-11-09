/** Sessions whose first message is still on its way to pi, and what waits behind it. */
export interface FirstMessages {
  /**
   * Holds back later messages to a session until the returned release is called.
   *
   * @remarks
   * Called once the session exists, before its box can be used; released once the first message
   * went, or did not.
   */
  hold(sessionId: string): () => void;
  /** Resolves once nothing holds the session's messages back; at once when nothing does. */
  after(sessionId: string): Promise<void>;
}

/**
 * Creates the holds for first messages.
 *
 * @remarks
 * SPEC-0008 ("真实模型检查后改"): a new direction's first message waits for the model to be set and
 * pi to start before it goes, so a message typed meanwhile into the discussion's box would reach pi
 * first. Each later message waits here for the first, and they then go in the order they were sent,
 * as each resumes in the order it began waiting. A release is idempotent, and a second hold on the
 * same session waits for the first too.
 *
 * @sideEffects none
 * @returns The holds.
 */
export function createFirstMessages(): FirstMessages {
  const held = new Map<string, Promise<void>>();
  return {
    hold(sessionId) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const before = held.get(sessionId) ?? Promise.resolve();
      const whole = Promise.all([before, promise]).then(() => undefined);
      held.set(sessionId, whole);
      // Stryker disable BlockStatement,ConditionalExpression,CallExpression: only frees memory; a resolved entry left behind waits for nothing.
      /**
       * Forgets the session once every hold on it ended.
       *
       * @remarks
       * Only the latest hold clears the entry: an earlier one ending leaves a later one waiting.
       *
       * @sideEffects Removes the session's entry.
       */
      const forget = async (): Promise<void> => {
        await whole;
        if (held.get(sessionId) === whole) held.delete(sessionId);
      };
      // Stryker restore BlockStatement,ConditionalExpression,CallExpression
      return () => {
        resolve();
        // Fire and forget: `whole` never rejects, and the entry only matters to later waits.
        void forget();
      };
    },
    after: async (sessionId) => held.get(sessionId),
  };
}

/** The page's holds, made on first use; see `firstMessages`. */
let page: FirstMessages | undefined;

/**
 * The page's holds for first messages.
 *
 * @remarks
 * One for the page, as the drafts (`pageDrafts`): the new-direction page holds a session back, and
 * the conversation area showing it waits.
 *
 * @sideEffects Creates the holds on first use.
 * @returns The holds.
 */
export function firstMessages(): FirstMessages {
  page ??= createFirstMessages();
  return page;
}

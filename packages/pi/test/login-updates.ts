import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { LoginUpdate } from "../src/auth/login";

/**
 * Collects a login's updates and lets a test wait for one.
 *
 * @remarks
 * Updates arrive as the login program writes them; `next` waits for the first that matches, which
 * may already have come.
 *
 * @sideEffects none
 * @returns The list, the listener to give `startLogin` and the wait.
 */
export function loginUpdates() {
  const seen: LoginUpdate[] = [];
  const waiting: { match: (update: LoginUpdate) => boolean; resolve: (update: LoginUpdate) => void }[] = [];
  return {
    seen,
    listener: (update: LoginUpdate) => {
      seen.push(update);
      for (const wait of waiting.splice(0)) {
        if (wait.match(update)) wait.resolve(update);
        else waiting.push(wait);
      }
    },
    next: async (match: (update: LoginUpdate) => boolean): Promise<LoginUpdate> => {
      const found = seen.find(match);
      if (found !== undefined) return found;
      const { promise, resolve } = Promise.withResolvers<LoginUpdate>();
      waiting.push({ match, resolve });
      return promise;
    },
  };
}

/**
 * The id of the question an update asks.
 *
 * @remarks
 * Keeps the narrowing out of the tests.
 *
 * @sideEffects none
 * @param update - An update that asks a question.
 * @returns Its id.
 * @throws {Error} When the update is not a question.
 */
export function promptIdOf(update: LoginUpdate): number {
  if (update.kind !== "prompt") throw new Error(`not a question: ${update.kind}`);
  return update.promptId;
}

/**
 * The authorization address an update gives.
 *
 * @remarks
 * Keeps the narrowing out of the tests.
 *
 * @sideEffects none
 * @param update - An update that gives the address.
 * @returns The address.
 * @throws {Error} When the update is something else.
 */
export function authUrlOf(update: LoginUpdate): URL {
  if (update.kind !== "event" || update.event.kind !== "auth_url") throw new Error(`not an address: ${update.kind}`);
  return new URL(update.event.url);
}

/**
 * Collects a login program's output lines, resolving once one contains a text.
 *
 * @remarks
 * For tests that drive the program directly, as a host that goes away would.
 *
 * @sideEffects Reads the child's stdout.
 * @param child - The program.
 * @param text - What to wait for.
 * @returns The lines so far, and the wait.
 */
export function outputLines(child: ChildProcessByStdio<Writable, Readable, null>, text: string) {
  const lines: string[] = [];
  const { promise: seen, resolve } = Promise.withResolvers<void>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    lines.push(...chunk.split("\n").filter((line) => line.length > 0));
    if (lines.some((line) => line.includes(text))) resolve();
  });
  return { lines, seen };
}

/**
 * Matches an update that asks the question with an id.
 *
 * @remarks
 * Keeps the condition out of the tests.
 *
 * @sideEffects none
 * @param promptId - The question's id.
 * @returns The match for `next`.
 */
export function asks(promptId: number): (update: LoginUpdate) => boolean {
  return (update) => update.kind === "prompt" && update.promptId === promptId;
}

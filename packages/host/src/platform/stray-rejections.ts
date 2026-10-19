import type { Logger } from "pino";

/** Where rejections nobody handled are heard: the process, or a stand-in in tests. */
export interface RejectionSource {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

/**
 * Logs every rejection nobody handled, instead of letting it end the host.
 *
 * @remarks
 * coding-standards.md ("不允许悬空的 Promise"): each fire-and-forget promise catches its own
 * failure; this is the fallback for one that slipped through, which Node 22 would otherwise turn
 * into a crash of the whole host and every session's pi with it. An `Error` is logged as `err`, as
 * everywhere; anything else only by its type, since its text could be a conversation's.
 *
 * @sideEffects Listens on `source` until the returned function is called; logs an error per rejection.
 * @param source - Where rejections are heard.
 * @param logger - Where they are logged.
 * @returns Stops listening.
 */
export function catchStrayRejections(source: RejectionSource, logger: Logger): () => void {
  /**
   * Logs one rejection.
   *
   * @remarks
   * See `catchStrayRejections`.
   *
   * @sideEffects Logs an error.
   * @param reason - What the promise rejected with.
   */
  const heard = (reason: unknown): void => {
    logger.error(reason instanceof Error ? { err: reason } : { reason: typeof reason }, "unhandled rejection");
  };
  source.on("unhandledRejection", heard);
  return () => {
    source.off("unhandledRejection", heard);
  };
}

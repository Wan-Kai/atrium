/**
 * The WebSocket constructor available in browsers and in Node 22 and later.
 *
 * @remarks
 * Declared here with only what the client needs, because the client package compiles without the
 * DOM library (overview.md, "包之间的依赖"); the client checks the instance's shape itself.
 */
declare const WebSocket: new (url: string) => import("./atrium-client").SocketLike;

/** The timer functions every JavaScript platform the client runs on provides. */
declare function setTimeout(callback: () => void, ms: number): unknown;
/** Cancels a timer from `setTimeout`. */
declare function clearTimeout(timer: unknown): void;

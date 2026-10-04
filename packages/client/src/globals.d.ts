/**
 * The WebSocket constructor available in browsers and in Node 22 and later.
 *
 * @remarks
 * Declared here with the minimal shape the client uses, because the client package compiles
 * without the DOM library (overview.md, "包之间的依赖").
 */
declare const WebSocket: new (url: string) => import("./connection").SocketLike;

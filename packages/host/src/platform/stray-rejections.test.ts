import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";
import { catchStrayRejections } from "./stray-rejections";

/**
 * A logger writing into memory.
 *
 * @remarks
 * The records are read back as objects, with the fields that change from run to run left out.
 *
 * @sideEffects none
 * @returns The logger, and what it wrote so far.
 */
function memoryLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger({ destination, level: "info", secrets: () => [], service: "host" });
  return { logger, records: () => lines.map((line) => recordOf(line)) };
}

/**
 * A log line's level, message and error, without its time and process.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns What the test compares.
 */
function recordOf(line: string): unknown {
  const record: unknown = JSON.parse(line);
  const err: unknown = Reflect.get(Object(record), "err");
  return {
    level: Reflect.get(Object(record), "level"),
    msg: Reflect.get(Object(record), "msg"),
    err:
      err === undefined
        ? undefined
        : { type: Reflect.get(Object(err), "type"), message: Reflect.get(Object(err), "message") },
    reason: Reflect.get(Object(record), "reason"),
  };
}

describe("catchStrayRejections", () => {
  it("logs a rejection nobody handled, an error whole and anything else only by its type, until let go", () => {
    const source = new EventEmitter();
    const { logger, records } = memoryLogger();
    const release = catchStrayRejections(source, logger);

    source.emit("unhandledRejection", new TypeError("boom"), Promise.resolve());
    source.emit("unhandledRejection", "the user's words", Promise.resolve());
    release();
    source.emit("unhandledRejection", new Error("after"), Promise.resolve());

    expect([records(), source.listenerCount("unhandledRejection")]).toStrictEqual([
      [
        { level: "error", msg: "unhandled rejection", err: { type: "TypeError", message: "boom" }, reason: undefined },
        { level: "error", msg: "unhandled rejection", err: undefined, reason: "string" },
      ],
      0,
    ]);
  });
});

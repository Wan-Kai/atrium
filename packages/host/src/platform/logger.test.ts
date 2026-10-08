import { createTempDir, present } from "@atrium/testkit";
import { pbkdf2 } from "node:crypto";
import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { closeLogFile, createLogger, drainLogFile, openLogFile } from "./logger";

const token = "SECRET-TOKEN-0123456789abcdefghijklmnopqrstuv";

/** A logger writing into memory, with the session token as the known secret. */
function memoryLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger({ destination, level: "info", secrets: () => [token], service: "host" });
  return { logger, lines };
}

describe("createLogger", () => {
  it.each([
    ["a format argument", (logger: ReturnType<typeof memoryLogger>["logger"]) => logger.info("got %s", token)],
    ["a template string", (logger: ReturnType<typeof memoryLogger>["logger"]) => logger.info(`got ${token}`)],
    [
      "an Error's default message",
      (logger: ReturnType<typeof memoryLogger>["logger"]) => logger.error(new Error(token)),
    ],
    [
      "an error under err",
      (logger: ReturnType<typeof memoryLogger>["logger"]) => logger.error({ err: new Error(token) }, "x"),
    ],
    [
      "a child binding value",
      (logger: ReturnType<typeof memoryLogger>["logger"]) => logger.child({ note: token }).info("x"),
    ],
  ])("keeps the token out of the line when it arrives as %s", (_label, write) => {
    const { logger, lines } = memoryLogger();

    write(logger);

    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain(token);
    expect(lines.join("")).toContain("[redacted]");
  });

  it("redacts credential keys in child bindings", () => {
    const { logger, lines } = memoryLogger();

    logger.child({ apiKey: "value-of-api-key" }).info("x");

    expect(JSON.parse(present(lines[0], "log line"))).toMatchObject({
      apiKey: "[redacted]",
      msg: "x",
      service: "host",
    });
  });
});

describe("openLogFile", () => {
  it("keeps at most five files, deleting files left by earlier runs when it rotates", async () => {
    const dir = await createTempDir("logs");
    onTestFinished(dir.cleanup);
    for (let n = 1; n <= 8; n++) await writeFile(join(dir.path, `host.${n}.jsonl`), "old\n");

    const { stream } = await openLogFile(dir.path, { maxSize: "1k" });
    for (let line = 0; line < 40; line++) stream.write(`${"x".repeat(100)}\n`);

    await vi.waitFor(
      async () => {
        const files = (await readdir(dir.path)).filter((name) => name.endsWith(".jsonl"));
        expect(files.length).toBeLessThanOrEqual(5);
        expect(files).not.toContain("host.1.jsonl");
      },
      { timeout: 10_000 },
    );
    await new Promise<void>((done) => {
      stream.once("close", () => done());
      stream.end();
    });
  });

  it("creates log files readable only by their owner, rotated ones included", async () => {
    const dir = await createTempDir("logs");
    onTestFinished(dir.cleanup);

    const { stream, currentPath } = await openLogFile(dir.path, { maxSize: "1k" });
    for (let line = 0; line < 30; line++) stream.write(`${"x".repeat(100)}\n`);
    await vi.waitFor(async () =>
      expect((await readdir(dir.path)).filter((name) => name.endsWith(".jsonl")).length).toBeGreaterThan(1),
    );
    await new Promise<void>((done) => {
      stream.once("close", () => done());
      stream.end();
    });

    const files = (await readdir(dir.path)).filter((name) => name.endsWith(".jsonl"));
    const modes = await Promise.all(files.map(async (name) => (await stat(join(dir.path, name))).mode & 0o777));
    expect(modes).toStrictEqual(files.map(() => 0o600));
    expect((await stat(currentPath)).mode & 0o777).toBe(0o600);
  });

  it("replaces a plain file named current.log with the link", async () => {
    const dir = await createTempDir("logs");
    onTestFinished(dir.cleanup);
    await writeFile(join(dir.path, "current.log"), "not a link");

    const { stream, currentPath } = await openLogFile(dir.path);

    expect((await lstat(currentPath)).isSymbolicLink()).toBe(true);
    stream.end();
  });

  it("reports a stream error on stderr instead of throwing it", async () => {
    const dir = await createTempDir("logs");
    onTestFinished(dir.cleanup);
    const { stream } = await openLogFile(dir.path);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    (stream as unknown as NodeJS.EventEmitter).emit("error", new Error("disk full"));

    expect(stderr).toHaveBeenCalledWith("atrium: log stream error: disk full\n");
    stderr.mockRestore();
    stream.end();
  });
});

/**
 * Keeps every thread of libuv's pool busy for a while.
 *
 * @remarks
 * A log write queued behind them is certain to be still in flight when the test writes more,
 * which is the moment the order of records on disk depends on.
 *
 * @sideEffects Runs key derivations on the thread pool.
 * @returns When they are done.
 */
function busyThreadPool(): Promise<unknown> {
  const threads = Number(process.env["UV_THREADPOOL_SIZE"] ?? 4);
  return Promise.all(
    Array.from({ length: threads }, () => new Promise((done) => pbkdf2("x", "salt", 300_000, 64, "sha512", done))),
  );
}

/**
 * A log file with one record whose write is still in flight and a second queued behind it.
 *
 * @remarks
 * The case where flushing at once would put the second record before the first.
 *
 * @sideEffects Creates a temporary log directory, removed when the test ends; writes two records.
 * @returns The stream, the file and when the thread pool is free again.
 */
async function writeWhileBusy() {
  const dir = await createTempDir("logs");
  onTestFinished(dir.cleanup);
  const { stream, currentPath } = await openLogFile(dir.path);
  const busy = busyThreadPool();
  stream.write("first\n");
  stream.write("second\n");
  return { stream, currentPath, busy };
}

describe("drainLogFile", () => {
  it("has every record written so far on disk, in the order written, while a write is in flight", async () => {
    const { stream, currentPath, busy } = await writeWhileBusy();

    await drainLogFile(stream);

    expect(await readFile(currentPath, "utf8")).toBe("first\nsecond\n");
    await busy;
    await closeLogFile(stream);
  });
});

describe("closeLogFile", () => {
  it("writes every record in the order written and closes, while a write is in flight", async () => {
    const { stream, currentPath, busy } = await writeWhileBusy();

    await closeLogFile(stream);

    expect(await readFile(currentPath, "utf8")).toBe("first\nsecond\n");
    expect(() => stream.write("third\n")).toThrow("SonicBoom destroyed");
    await busy;
  });
});

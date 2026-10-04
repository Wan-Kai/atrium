import { createTempDir, present } from "@atrium/testkit";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger, openLogFile } from "./logger";

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
    await dir.cleanup();
  });

  it("replaces a plain file named current.log with the link", async () => {
    const dir = await createTempDir("logs");
    await writeFile(join(dir.path, "current.log"), "not a link");

    const { stream, currentPath } = await openLogFile(dir.path);

    expect((await lstat(currentPath)).isSymbolicLink()).toBe(true);
    stream.end();
    await dir.cleanup();
  });

  it("reports a stream error on stderr instead of throwing it", async () => {
    const dir = await createTempDir("logs");
    const { stream } = await openLogFile(dir.path);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    (stream as unknown as NodeJS.EventEmitter).emit("error", new Error("disk full"));

    expect(stderr).toHaveBeenCalledWith("atrium: log stream error: disk full\n");
    stderr.mockRestore();
    stream.end();
    await dir.cleanup();
  });
});

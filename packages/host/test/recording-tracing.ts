import { Writable } from "node:stream";
import { createLogger } from "../src/platform/logger";
import { ResourceTracker } from "../src/platform/resources";
import { setupTracing } from "../src/platform/tracing";

/**
 * A logger and tracer that write into memory, for tests that check log lines and span records.
 *
 * @remarks
 * Spans are exported as `kind: "span"` log records, so one array holds the whole picture
 * (observability.md, "和测试的关系").
 *
 * @sideEffects Installs the global context manager on first use.
 * @returns The parsed log records, logger, tracer, resource tracker and a shutdown function.
 */
export function recordingTracing() {
  const records: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line !== "") records.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  const logger = createLogger({ destination, level: "debug", secrets: () => [], service: "host" });
  const resources = new ResourceTracker();
  const tracing = setupTracing({ logger, resources, version: "test" });
  return { records, logger, resources, tracer: tracing.tracer, shutdown: tracing.shutdown };
}

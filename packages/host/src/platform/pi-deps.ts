import type { PiDeps } from "@atrium/pi";
import { trace } from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import { type Clock, trackedTimeout } from "./clock";
import type { Logger } from "./logger";
import type { ResourceTracker } from "./resources";

/**
 * Builds the dependencies the pi package needs from the host's own infrastructure.
 *
 * @remarks
 * The pi package must not import the host, so it defines `PiDeps` and the host fills it in here
 * (overview.md, "pi 包拿到宿主基础设施的方式"). Timers go through `trackedTimeout`, so a timer pi
 * forgets shows up in the leak tests' `timer` count. The logger already adds the active span's
 * trace and span ids. A request id is the active span's id plus a sequence number: the span id
 * ties pi's response to the span that sent the command (observability.md, "pi 进程"), and
 * the number keeps ids unique when one span sends several commands.
 *
 * @sideEffects none; the returned functions count resources, schedule timers and write logs.
 * @param options - Clock, resource tracker, logger and the environment for pi.
 * @returns The dependencies.
 */
export function createPiDeps(options: {
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly env: Readonly<Record<string, string>>;
}): PiDeps {
  const { clock, resources, logger } = options;
  let sequence = 0;
  return {
    clock: {
      now: () => clock.now(),
      setTimeout: (callback, ms) => trackedTimeout(clock, resources, callback, ms),
    },
    track: (kind) => resources.acquire(kind),
    log: {
      debug: (fields, message) => logger.debug(fields, message),
      info: (fields, message) => logger.info(fields, message),
      warn: (fields, message) => logger.warn(fields, message),
      error: (fields, message) => logger.error(fields, message),
    },
    nextRequestId: () => {
      const spanId = trace.getActiveSpan()?.spanContext().spanId ?? randomBytes(8).toString("hex");
      sequence += 1;
      return `${spanId}-${sequence}`;
    },
    env: options.env,
  };
}

import {
  type PiCommand,
  type PiDeps,
  type PiLaunch,
  type PiProcess,
  type PiProcessOptions,
  type PiResponseData,
  startPiProcess,
} from "@atrium/pi";
import { SpanStatusCode, type Tracer, context, trace } from "@opentelemetry/api";
import { inSpan } from "../platform/tracing";

/** A pi process whose lifetime and commands are recorded as spans. */
export interface TracedPi {
  readonly process: PiProcess;
  /** `PiProcess.request` inside its own `pi.rpc <command>` span. */
  request<C extends PiCommand>(
    command: C,
    options?: { readonly timeoutMs?: number | null; readonly signal?: AbortSignal },
  ): Promise<PiResponseData<C["type"]>>;
}

/**
 * Starts pi inside a `pi.process` span that lasts until pi exits.
 *
 * @remarks
 * pi is spawned with the span active, and Node runs a child's stream callbacks in the context it
 * was spawned in, so pi's stderr lines and lifecycle logs carry this span's ids without the pi
 * package knowing about tracing (observability.md, "pi 进程"). The span ends with pi's exit
 * code; an exit nobody asked for marks it as an error. Each command gets a `pi.rpc` span under the
 * caller's span, and its RPC id is derived from that span's id by `PiDeps.nextRequestId`.
 *
 * @sideEffects Spawns pi; starts a span that ends when pi exits.
 * @param options - Launch details, pi dependencies, tracer and process options.
 * @returns The process and a traced request function.
 */
export function startTracedPi(options: {
  readonly launch: PiLaunch;
  readonly deps: PiDeps;
  readonly tracer: Tracer;
  readonly processOptions?: PiProcessOptions;
}): TracedPi {
  const span = options.tracer.startSpan("pi.process", {
    attributes: { "pi.path": options.launch.piPath, "pi.cwd": options.launch.cwd },
  });
  const pi = context.with(trace.setSpan(context.active(), span), () =>
    startPiProcess(options.launch, options.deps, options.processOptions),
  );
  if (pi.pid !== undefined) span.setAttribute("pi.pid", pi.pid);

  /**
   * Ends the `pi.process` span with pi's exit.
   *
   * @remarks
   * Whoever stops pi, or if it crashes, the span still ends, so the leak tests' open-span count
   * returns to zero.
   *
   * @sideEffects Sets span attributes and status; ends the span.
   */
  async function endWithExit(): Promise<void> {
    const exit = await pi.exited;
    span.setAttributes({
      "pi.exit.code": exit.code ?? -1,
      "pi.exit.signal": exit.signal ?? "",
      "pi.exit.requested": exit.requested,
    });
    if (!exit.requested) span.setStatus({ code: SpanStatusCode.ERROR, message: "pi exited unexpectedly" });
    span.end();
  }
  // Fire and forget: `exited` never rejects, so this cannot fail.
  void endWithExit();

  return {
    process: pi,
    request: (command, requestOptions) =>
      inSpan(options.tracer, `pi.rpc ${command.type}`, () => pi.request(command, requestOptions)),
  };
}

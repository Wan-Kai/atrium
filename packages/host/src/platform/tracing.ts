import {
  type Context,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  TraceFlags,
  context,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult, hrTimeToMilliseconds } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { parseTraceparent } from "@atrium/protocol";
import type { Logger } from "./logger";
import type { ResourceTracker } from "./resources";

/** A configured tracer and the means to flush it on shutdown. */
export interface Tracing {
  readonly tracer: Tracer;
  /** Flushes pending spans and stops the provider. */
  readonly shutdown: () => Promise<void>;
}

let contextManagerInstalled = false;

/**
 * Installs the AsyncLocalStorage context manager once per process.
 *
 * @remarks
 * With it, the active span follows `await` automatically, so code does not thread a context
 * through every call (observability.md, "方案"). It is process-global, while providers are
 * per host instance, so several hosts can run in one test process without clashing.
 *
 * @sideEffects Sets the global OpenTelemetry context manager on first call.
 */
function installContextManager(): void {
  if (contextManagerInstalled) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  contextManagerInstalled = true;
}

/**
 * Sets up tracing that records finished spans as `kind: "span"` log records.
 *
 * @remarks
 * Spans go to the same JSONL log as ordinary records, so `pnpm trace <id>` can rebuild a whole
 * chain from one file and nothing leaves the machine by default (observability.md, "方案").
 * Open spans are counted as resources so leak tests catch spans that never end.
 *
 * @sideEffects Installs the global context manager once; every ended span is written to `logger`;
 * every started span is counted in `resources` until it ends.
 * @param options - Logger to write spans to, resource tracker, and service version.
 * @returns The tracer and a shutdown function.
 */
export function setupTracing(options: {
  readonly logger: Logger;
  readonly resources: ResourceTracker;
  readonly version: string;
}): Tracing {
  installContextManager();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "atrium-host", "service.version": options.version }),
    spanProcessors: [
      new OpenSpanCounter(options.resources),
      new SimpleSpanProcessor({ exporter: new LogSpanExporter(options.logger) }),
    ],
  });
  return { tracer: provider.getTracer("atrium-host", options.version), shutdown: () => provider.shutdown() };
}

/**
 * Builds a context whose parent is the span described by a `traceparent` value.
 *
 * @remarks
 * Commands from clients carry the trace they belong to; spans the host starts under this context
 * join that trace. Invalid values fall back to a fresh root so a bad header cannot break handling.
 *
 * @sideEffects none
 * @param traceparent - Value received from a client.
 * @returns A context with a remote parent span, or the root context.
 */
export function contextFromTraceparent(traceparent: string): Context {
  const parsed = parseTraceparent(traceparent);
  if (parsed === null) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

/**
 * Runs synchronous `work` inside a new active span and ends the span before returning.
 *
 * @remarks
 * Centralizes the start/try/finally pattern so no code path can leave a span open, which the
 * leak tests would report. It is synchronous on purpose: the handshake must decide within the
 * same turn of the event loop as the message that carries it, so frames that arrive in the same
 * TCP read already see the result. An async variant is added when async work needs spans.
 *
 * @sideEffects Starts and ends a span; records an exception and error status if `work` throws.
 * @param tracer - Tracer to start the span on.
 * @param name - Span name, such as `ws.connect`.
 * @param parent - Parent context.
 * @param work - Code to run with the span active.
 * @returns Whatever `work` returns.
 */
export function inSyncSpan<T>(tracer: Tracer, name: string, parent: Context, work: (span: Span) => T): T {
  return tracer.startActiveSpan(name, {}, parent, (span) => {
    try {
      return work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs asynchronous `work` inside a new active span and ends the span when it settles.
 *
 * @remarks
 * The async counterpart of `inSyncSpan`, with the same guarantee that no path leaves the span
 * open. The parent defaults to the span active where it is called, so spans nest the way the
 * code calls itself (observability.md, "一条链路包含什么").
 *
 * @sideEffects Starts and ends a span; records an exception and error status if `work` rejects.
 * @param tracer - Tracer to start the span on.
 * @param name - Span name, such as `pi.rpc prompt`.
 * @param work - Code to run with the span active.
 * @param parent - Parent context; defaults to the active one.
 * @param links - Spans this one relates to without being their child, such as a connection's.
 * @returns Whatever `work` resolves with.
 */
export function inSpan<T>(
  tracer: Tracer,
  name: string,
  work: (span: Span) => Promise<T>,
  parent: Context = context.active(),
  links: readonly Link[] = [],
): Promise<T> {
  return tracer.startActiveSpan(name, { links: [...links] }, parent, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Span processor that counts spans between start and end.
 *
 * @remarks
 * Feeds the `span` resource count used by leak tests.
 *
 * @sideEffects Updates `resources` on every span start and end.
 */
class OpenSpanCounter implements SpanProcessor {
  readonly #resources: ResourceTracker;
  readonly #open = new WeakMap<object, () => void>();

  /**
   * Creates a counter that writes to `resources`.
   *
   * @remarks Keeps the tracker the counts are written to.
   * @sideEffects none
   * @param resources - Tracker to count spans in.
   */
  constructor(resources: ResourceTracker) {
    this.#resources = resources;
  }

  /**
   * Counts a span as open.
   *
   * @remarks Called by the SDK when a span starts.
   * @sideEffects Acquires one `span` resource.
   * @param span - The started span.
   */
  onStart(span: Span): void {
    this.#open.set(span, this.#resources.acquire("span"));
  }

  /**
   * Releases the count taken when the span started.
   *
   * @remarks Called by the SDK when a span ends.
   * @sideEffects Releases the span's resource.
   * @param span - The ended span.
   */
  onEnd(span: ReadableSpan): void {
    this.#open.get(span)?.();
  }

  /**
   * Flushes buffered work.
   *
   * @remarks Nothing is buffered, so there is nothing to flush.
   * @sideEffects none
   * @returns A resolved promise.
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Stops the processor.
   *
   * @remarks Nothing to release on shutdown.
   * @sideEffects none
   * @returns A resolved promise.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Exports finished spans as structured log records.
 *
 * @remarks
 * Field names follow the log format in observability.md ("日志格式") so spans and logs share
 * `trace_id` and `span_id`.
 *
 * @sideEffects Writes one log record per exported span.
 */
class LogSpanExporter implements SpanExporter {
  readonly #logger: Logger;

  /**
   * Creates an exporter that writes to `logger`.
   *
   * @remarks Keeps the logger spans are written to.
   * @sideEffects none
   * @param logger - Destination logger.
   */
  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /**
   * Writes finished spans as log records.
   *
   * @remarks Called by the span processor with finished spans.
   * @sideEffects Writes a log record per span.
   * @param spans - Finished spans.
   * @param resultCallback - Reports success back to the SDK.
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      const { traceId, spanId } = span.spanContext();
      this.#logger.info(
        {
          kind: "span",
          name: span.name,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: span.parentSpanContext?.spanId,
          start: new Date(hrTimeToMilliseconds(span.startTime)).toISOString(),
          duration_ms: hrTimeToMilliseconds(span.duration),
          status: span.status.code === SpanStatusCode.ERROR ? "error" : "ok",
          attributes: span.attributes,
          links: span.links.map((link) => ({ trace_id: link.context.traceId, span_id: link.context.spanId })),
          events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
        },
        `span ${span.name}`,
      );
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  /**
   * Stops the exporter.
   *
   * @remarks The logger is owned and flushed by the host, so there is nothing to close here.
   * @sideEffects none
   * @returns A resolved promise.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

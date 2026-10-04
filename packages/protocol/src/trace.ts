/** Parsed form of a W3C `traceparent` value. */
export interface TraceContext {
  /** 32 lowercase hex characters, never all zeros. */
  readonly traceId: string;
  /** 16 lowercase hex characters, never all zeros. */
  readonly spanId: string;
  /** Whether the caller asked for this trace to be recorded. */
  readonly sampled: boolean;
}

/** Source of random bytes; injectable so tests can produce known ids. */
export type RandomBytes = (length: number) => Uint8Array;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * Reads random bytes from the platform's cryptographic generator.
 *
 * @remarks
 * Trace ids must be unique across processes and restarts; `crypto.getRandomValues` exists in
 * both Node and browsers, so the client and the host share this implementation.
 *
 * @sideEffects Consumes entropy from the platform generator.
 * @param length - Number of bytes to return.
 * @returns Fresh random bytes.
 */
export function cryptoRandomBytes(length: number): Uint8Array {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- protocol compiles without DOM or Node types; both runtimes provide Web Crypto.
  const { crypto } = globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } };
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Encodes bytes as lowercase hex.
 *
 * @remarks
 * W3C Trace Context requires lowercase hex for both ids.
 *
 * @sideEffects none
 * @param bytes - Bytes to encode.
 * @returns The hex string, two characters per byte.
 */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Generates an id of the given byte length that is not all zeros.
 *
 * @remarks
 * W3C Trace Context treats all-zero ids as invalid, so a zero draw is retried.
 *
 * @sideEffects Calls `random`.
 * @param byteLength - 16 for trace ids, 8 for span ids.
 * @param random - Random byte source.
 * @returns A lowercase hex id.
 */
function generateId(byteLength: number, random: RandomBytes): string {
  for (;;) {
    const id = toHex(random(byteLength));
    if (/[^0]/.test(id)) return id;
  }
}

/**
 * Starts a new trace with a fresh root span.
 *
 * @remarks
 * Every user action begins a trace in the client so the host can attach its spans and logs to
 * the same chain (observability.md, "一条链路包含什么").
 *
 * @sideEffects Calls `random`.
 * @param random - Random byte source; defaults to the platform's cryptographic generator.
 * @returns A sampled trace context.
 */
export function createTraceContext(random: RandomBytes = cryptoRandomBytes): TraceContext {
  return { traceId: generateId(16, random), spanId: generateId(8, random), sampled: true };
}

/**
 * Serializes a trace context as a version-00 `traceparent` header value.
 *
 * @remarks
 * The protocol carries trace context in this standard form so the ids can later be exported to
 * OpenTelemetry tools unchanged.
 *
 * @sideEffects none
 * @param context - The context to serialize.
 * @returns A string such as `00-<trace id>-<span id>-01`.
 */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/**
 * Parses a version-00 `traceparent` value.
 *
 * @remarks
 * Values come from the network, so anything malformed, including all-zero ids, is rejected
 * rather than repaired; the host then starts a fresh trace instead of joining a bogus one.
 *
 * @sideEffects none
 * @param value - The header value to parse.
 * @returns The trace context, or `null` when the value is not a valid version-00 traceparent.
 */
export function parseTraceparent(value: string): TraceContext | null {
  const match = TRACEPARENT.exec(value);
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  // Stryker disable next-line all: the pattern has three mandatory groups, so a match always fills them; this only narrows the type.
  if (traceId === undefined || spanId === undefined || flags === undefined) return null;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

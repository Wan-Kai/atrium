import type { FixtureRecord, Json, JsonObject } from "./format";

/** Fixture header fields other than `kind`. */
export type FixtureHeader = Omit<Extract<FixtureRecord, { kind: "fixture" }>, "kind">;

/** Collects one scenario's traffic as normalized fixture records. */
export interface FixtureRecorder {
  /** Pass as `PiProcessOptions.tap`. */
  readonly tap: { sent(record: object): void; received(record: object): void };
  /** Records how pi ended and whether the host asked it to. */
  exit(code: number | null, signal: string | null, requested: boolean): void;
  /** Records the session file's lines at the end of the scenario. */
  session(lines: readonly object[]): void;
  /** Everything recorded so far, header first. */
  records(): FixtureRecord[];
}

/**
 * Creates a recorder that normalizes each record as it arrives.
 *
 * @remarks
 * Normalizing in arrival order means tokens for ids are numbered by first appearance in the
 * conversation, which is what makes re-recordings identical (testing.md, "pi 夹具").
 *
 * @sideEffects none; the recorder keeps the records in memory.
 * @param header - Scenario, pi version, faux script and pi arguments.
 * @param normalize - From `createNormalizer`.
 * @returns The recorder.
 */
export function createRecorder(header: FixtureHeader, normalize: (value: Json) => Json): FixtureRecorder {
  const records: FixtureRecord[] = [{ kind: "fixture", ...header }];

  /**
   * Normalizes one protocol record.
   *
   * @remarks
   * Protocol records are JSON objects, and normalizing keeps their shape.
   *
   * @sideEffects Advances the normalizer's numbering.
   * @param record - A record as written or printed.
   * @returns The normalized record.
   */
  function object(record: object): JsonObject {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
    return normalize(record as Json) as JsonObject;
  }
  return {
    tap: {
      sent: (record) => records.push({ kind: "send", record: object(record) }),
      received: (record) => records.push({ kind: "stdout", record: object(record) }),
    },
    exit: (code, signal, requested) => records.push({ kind: "exit", code, signal, requested }),
    session: (lines) => records.push({ kind: "session", lines: lines.map(object) }),
    records: () => [...records],
  };
}

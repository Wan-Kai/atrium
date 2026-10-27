import { createHash } from "node:crypto";
import {
  CommandError,
  CommandResult,
  ErrorCode,
  ErrorParams,
  type PromptCommand,
  type SteerCommand,
} from "@atrium/protocol";
import { z } from "zod";
import type { Clock } from "../platform/clock";
import { type IndexFile, loadIndexFile } from "../store/index-file";

/** How long a receipt is kept (SPEC-0005, "协议改动" 4). */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** The most receipts kept for one device; the oldest go first. */
export const RECEIPTS_PER_DEVICE = 200;

/** A phone's command that takes a receipt. */
type ReceiptCommand = PromptCommand | SteerCommand;

/** What such a command answers. */
type ReceiptResult = CommandResult<"prompt"> | CommandResult<"steer">;

/** One receipt as stored. */
const Receipt = z.looseObject({
  deviceId: z.string(),
  requestId: z.string(),
  hash: z.string(),
  at: z.number().int().nonnegative(),
  state: z.enum(["processing", "done", "unknown"]),
  /** The answer of a finished request: its result, or its failure's code and parameters. */
  response: z
    .union([
      z.looseObject({ ok: z.literal(true), result: z.unknown() }),
      z.looseObject({ ok: z.literal(false), code: ErrorCode, params: ErrorParams.optional() }),
    ])
    .optional(),
});
type Receipt = z.infer<typeof Receipt>;

/** The receipts file's document. */
const ReceiptsDocument = z.looseObject({ receipts: z.array(Receipt) });
type ReceiptsDocument = z.infer<typeof ReceiptsDocument>;

/** Runs a phone's `prompt` or `steer` at most once per request id (SPEC-0005, "MP4b 定的细节"). */
export interface ReceiptBook {
  /**
   * Runs the command unless its request was seen before, and answers as the first time did.
   *
   * @throws `CommandError`: the command's own failure, or `request_conflict`, `outcome_unknown`
   * (also when the command crashed), `internal_error` (the request could not be written down, so it
   * was not run).
   */
  run(deviceId: string, command: ReceiptCommand, execute: () => Promise<ReceiptResult>): Promise<ReceiptResult>;
  /** Waits for writes in progress; never rejects. */
  flush(): Promise<void>;
}

/** Ways to replace the file write, for tests, and where to log. */
export interface ReceiptOptions {
  readonly write?: (path: string, content: string) => Promise<void>;
  /** Logs a crash of a command and a receipt that could not be written; no message content. */
  readonly log?: (level: "warn" | "error", message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/**
 * Loads the receipts kept in `directory/receipts.json`.
 *
 * @remarks
 * The file is an index file (versioned, written atomically, set aside when damaged). A request
 * still `processing` when it was last written did not finish as far as anyone can tell, so it comes
 * back as `unknown`: asked again, it answers `outcome_unknown` and is not run (SPEC-0005, "协议改动"
 * 4: no exactly-once, only no second delivery through a retry). Expired receipts are dropped.
 *
 * @sideEffects Reads the file; may set a damaged one aside or rewrite an old version.
 * @param directory - Where the file lives, `<ATRIUM_HOME>/remote`.
 * @param clock - The host's clock.
 * @param options - A replacement for the file write, for tests.
 * @returns The receipts.
 */
export async function openReceipts(
  directory: string,
  clock: Clock,
  options: ReceiptOptions = {},
): Promise<ReceiptBook> {
  const { file } = await loadIndexFile(
    directory,
    { name: "receipts", version: 1, schema: ReceiptsDocument, empty: () => ({ receipts: [] }) },
    clock.now(),
    ...(options.write === undefined ? [] : [options.write]),
  );
  return createReceiptBook(file, clock, options.log);
}

/**
 * Keeps receipts in memory and on file.
 *
 * @remarks
 * See `ReceiptBook`. Requests under way in this process are joined, not run again.
 *
 * @sideEffects none until used.
 * @param file - The receipts file.
 * @param clock - The host's clock.
 * @param log - Where to log.
 * @returns The book.
 */
function createReceiptBook(file: IndexFile<ReceiptsDocument>, clock: Clock, log: ReceiptOptions["log"]): ReceiptBook {
  const receipts = new Map<string, Receipt>();
  // A receipt read back as `processing` did not finish as far as anyone can tell: without an
  // answer, it answers `outcome_unknown` below like an `unknown` one. Expired ones are never
  // answered from and leave the file at its next write.
  for (const receipt of file.read().receipts) receipts.set(keyOf(receipt.deviceId, receipt.requestId), receipt);
  // Requests under way, by key: they are joined by key and content whatever the kept history says.
  const running = new Map<string, { readonly hash: string; readonly result: Promise<ReceiptResult> }>();

  /**
   * Drops expired receipts and those past each device's limit, then writes the rest.
   *
   * @remarks
   * Oldest first when a device has too many; a request under way is never dropped.
   *
   * @sideEffects Changes the map; writes the file.
   * @returns When written; rejects when the write fails.
   */
  function save(): Promise<void> {
    const now = clock.now();
    const byDevice = new Map<string, Receipt[]>();
    for (const [key, receipt] of receipts) {
      if (now - receipt.at > RECEIPT_TTL_MS) {
        receipts.delete(key);
        continue;
      }
      if (!running.has(key)) byDevice.set(receipt.deviceId, [...(byDevice.get(receipt.deviceId) ?? []), receipt]);
    }
    for (const kept of byDevice.values()) {
      const oldest = kept.toSorted((a, b) => a.at - b.at).slice(0, Math.max(0, kept.length - RECEIPTS_PER_DEVICE));
      for (const receipt of oldest) receipts.delete(keyOf(receipt.deviceId, receipt.requestId));
    }
    return file.save({ receipts: [...receipts.values()] });
  }

  /**
   * Runs a new request: writes it down, runs it, records how it ended.
   *
   * @remarks
   * Not run when it cannot be written down first. A failure to record the end is only logged by
   * the caller's silence: the receipt then reads `processing`, `unknown` after a restart.
   *
   * @sideEffects Writes the file; runs `execute`.
   * @param key - The receipt's key.
   * @param receipt - The new receipt, `processing`.
   * @param type - The command's type, for the log.
   * @param execute - Runs the command.
   * @returns The command's result.
   */
  async function first(
    key: string,
    receipt: Receipt,
    type: ReceiptCommand["type"],
    execute: () => Promise<ReceiptResult>,
  ): Promise<ReceiptResult> {
    receipts.set(key, receipt);
    try {
      await save();
    } catch {
      receipts.delete(key);
      throw new CommandError("internal_error");
    }
    try {
      const result = await execute();
      receipts.set(key, { ...receipt, state: "done", response: { ok: true, result } });
      return result;
    } catch (error) {
      receipts.set(
        key,
        error instanceof CommandError
          ? {
              ...receipt,
              state: "done",
              response: {
                ok: false,
                code: error.code,
                ...(error.params === undefined ? {} : { params: error.params }),
              },
            }
          : { ...receipt, state: "unknown" },
      );
      if (error instanceof CommandError) throw error;
      // It may have run in part: the phone is told it cannot know, as it would be when asking again.
      log?.("error", "remote command crashed", { err: error, command: type });
      throw new CommandError("outcome_unknown");
    } finally {
      // The answer goes out even when it cannot be written; a restart then reads it as unknown.
      await save().catch((error: unknown) => log?.("warn", "receipt not written", { err: error }));
    }
  }

  return {
    async run(deviceId, command, execute) {
      const key = keyOf(deviceId, command.requestId);
      const hash = hashOf(command);
      const under = running.get(key);
      if (under !== undefined) {
        if (under.hash !== hash) throw new CommandError("request_conflict");
        return under.result;
      }
      const known = receipts.get(key);
      const expired = known !== undefined && clock.now() - known.at > RECEIPT_TTL_MS;
      if (known !== undefined && !expired) {
        if (known.hash !== hash) throw new CommandError("request_conflict");
        // Only a finished request has its answer; one `processing` or `unknown` cannot tell.
        if (known.response === undefined) throw new CommandError("outcome_unknown");
        if (known.response.ok) return CommandResult[command.type].parse(known.response.result);
        throw new CommandError(known.response.code, known.response.params);
      }
      const receipt: Receipt = { deviceId, requestId: command.requestId, hash, at: clock.now(), state: "processing" };
      const result = first(key, receipt, command.type, execute);
      running.set(key, { hash, result });
      try {
        return await result;
      } finally {
        running.delete(key);
      }
    },
    flush: () => file.flush(),
  };
}

/**
 * The key of a request.
 *
 * @remarks
 * A NUL never appears in either id.
 *
 * @sideEffects none
 * @param deviceId - The phone.
 * @param requestId - The request.
 * @returns The key.
 */
function keyOf(deviceId: string, requestId: string): string {
  return `${deviceId}\u0000${requestId}`;
}

/**
 * What makes two requests with one id the same request.
 *
 * @remarks
 * The command, its session, its text and how many attachments it has; not the attachments' ids,
 * which change when the phone uploads them again after a reconnect, nor the trace (SPEC-0005,
 * "协议改动" 4).
 *
 * @sideEffects none
 * @param command - The command.
 * @returns A hex SHA-256.
 */
function hashOf(command: ReceiptCommand): string {
  const fields = [command.type, command.sessionId, command.text, command.attachmentIds?.length ?? 0];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

import { CommandError } from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { PromptImage } from "../sessions/session-controller";

/** Images uploaded ahead of the messages that go with them (SPEC-0001, "附件"). */
export interface AttachmentStore {
  /** Keeps an upload for a connection; returns its id. */
  put(connectionId: string, mimeType: string, data: string): string;
  /** Sends a message with uploads, all or none, taking them off once the message is taken. */
  use<T>(connectionId: string, ids: readonly string[], send: (images: PromptImage[]) => Promise<T>): Promise<T>;
  /** Lets a closed connection's uploads go. */
  drop(connectionId: string): void;
  /** Lets every upload go. */
  close(): void;
}

/** One kept upload. */
interface Kept {
  readonly connectionId: string;
  readonly image: PromptImage;
  readonly bytes: number;
  readonly expire: () => void;
}

/**
 * Creates the store of uploaded images.
 *
 * @remarks
 * SPEC-0001 ("附件"): images are kept in memory per connection, up to a total size and count; a
 * message taken by its session takes them off, and so does the connection closing or 30 minutes
 * passing unused. A message the session refuses leaves them, so it can go again. Once
 * a message is queued its images go with the queue item, no longer counted here. A message naming
 * an image not here takes none, so it is not sent short of one.
 *
 * @sideEffects none until `put`; then holds images and schedules their expiry on the clock.
 * @param options - The clock, an id source, and the limits.
 * @returns The store.
 */
export function createAttachmentStore(options: {
  readonly clock: Clock;
  readonly newId: () => string;
  readonly maxBytes: number;
  readonly maxCount: number;
  readonly keepMs: number;
}): AttachmentStore {
  const kept = new Map<string, Kept>();

  /**
   * Lets one upload go.
   *
   * @remarks
   * Its expiry timer goes with it.
   *
   * @sideEffects Removes it; cancels its timer.
   * @param id - The upload.
   */
  function release(id: string): void {
    kept.get(id)?.expire();
    kept.delete(id);
  }

  return {
    put(connectionId, mimeType, data) {
      const bytes = Buffer.byteLength(data, "base64");
      const own = [...kept.values()].filter((one) => one.connectionId === connectionId);
      const used = own.reduce((sum, one) => sum + one.bytes, 0);
      if (own.length >= options.maxCount || used + bytes > options.maxBytes) {
        throw new CommandError("attachment_limit");
      }
      const id = options.newId();
      const expire = options.clock.setTimeout(() => kept.delete(id), options.keepMs);
      kept.set(id, { connectionId, image: { data, mimeType }, bytes, expire });
      return id;
    },
    async use(connectionId, ids, send) {
      const missing = ids.find((id) => kept.get(id)?.connectionId !== connectionId);
      if (missing !== undefined) throw new CommandError("attachment_missing", { attachmentId: missing });
      const images = ids.flatMap((id) => {
        const one = kept.get(id);
        return one === undefined ? [] : [one.image];
      });
      const sent = await send(images);
      for (const id of ids) release(id);
      return sent;
    },
    drop(connectionId) {
      for (const [id, one] of kept) if (one.connectionId === connectionId) release(id);
    },
    close() {
      for (const id of kept.keys()) release(id);
    },
  };
}

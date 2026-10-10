import { CommandError } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { createAttachmentStore } from "./attachments";

/** Base64 of `bytes` bytes. */
function data(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString("base64");
}

/** A store with small limits, ids a1, a2, … and a fake clock. */
function store(limits: { bytes?: number; count?: number } = {}) {
  const clock = new FakeClock();
  let next = 0;
  const attachments = createAttachmentStore({
    clock,
    newId: () => `a${++next}`,
    maxBytes: limits.bytes ?? 100,
    maxCount: limits.count ?? 3,
    keepMs: 30 * 60_000,
  });
  /**
   * Sends a message with these uploads, the message giving back the images it got.
   *
   * @sideEffects Takes the uploads off.
   */
  const take = (connectionId: string, ids: readonly string[]) =>
    attachments.use(connectionId, ids, async (images) => images);
  return { attachments, clock, take };
}

describe("createAttachmentStore", () => {
  it("keeps an upload until a message takes it, as pi's images", async () => {
    const { attachments, take } = store();
    const id = attachments.put("c1", "image/webp", data(10));

    expect(id).toBe("a1");
    expect(await take("c1", [id])).toStrictEqual([{ data: data(10), mimeType: "image/webp" }]);
    await expect(take("c1", [id])).rejects.toStrictEqual(
      new CommandError("attachment_missing", { attachmentId: "a1" }),
    );
  });

  it("keeps the uploads of a message that fails, for it to go again", async () => {
    const { attachments, take } = store();
    const id = attachments.put("c1", "image/webp", data(10));

    await expect(
      attachments.use("c1", [id], async () => {
        throw new CommandError("session_stopping");
      }),
    ).rejects.toStrictEqual(new CommandError("session_stopping"));
    expect(await take("c1", [id])).toStrictEqual([{ data: data(10), mimeType: "image/webp" }]);
  });

  it("lets one message at a time use an upload, freeing it again when that message fails", async () => {
    const { attachments, take } = store();
    const id = attachments.put("c1", "image/webp", data(10));
    const sending = Promise.withResolvers<string>();
    const first = attachments.use("c1", [id], () => sending.promise);

    await expect(take("c1", [id])).rejects.toStrictEqual(new CommandError("attachment_missing", { attachmentId: id }));
    sending.reject(new CommandError("session_stopping"));
    await expect(first).rejects.toStrictEqual(new CommandError("session_stopping"));

    expect(await take("c1", [id])).toHaveLength(1);
  });

  it("gives a connection only its own uploads, and takes none when one is missing", async () => {
    const { attachments, take } = store();
    const mine = attachments.put("c1", "image/png", data(1));
    const theirs = attachments.put("c2", "image/png", data(1));

    await expect(take("c1", [mine, theirs])).rejects.toStrictEqual(
      new CommandError("attachment_missing", { attachmentId: theirs }),
    );
    expect(await take("c1", [mine])).toHaveLength(1);
  });

  it("refuses an upload past a connection's count alone, with bytes to spare", async () => {
    const { attachments } = store({ bytes: 1000, count: 2 });
    attachments.put("c1", "image/png", data(1));
    attachments.put("c1", "image/png", data(1));

    expect(() => attachments.put("c1", "image/png", data(1))).toThrow(new CommandError("attachment_limit"));
  });

  it("lets an upload go when it expired while its message was on its way", async () => {
    const { attachments, clock } = store();
    const id = attachments.put("c1", "image/png", data(1));

    const sent = await attachments.use("c1", [id], async (images) => {
      clock.advance(30 * 60_000);
      return images.length;
    });

    expect(sent).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("refuses an upload past a connection's limit in bytes or count, counting what was taken off", async () => {
    const { attachments, take } = store({ bytes: 30, count: 2 });
    const first = attachments.put("c1", "image/png", data(20));

    expect(() => attachments.put("c1", "image/png", data(11))).toThrow(new CommandError("attachment_limit"));
    attachments.put("c1", "image/png", data(10));
    expect(() => attachments.put("c1", "image/png", data(1))).toThrow(new CommandError("attachment_limit"));
    attachments.put("c2", "image/png", data(30));
    await take("c1", [first]);
    expect(attachments.put("c1", "image/png", data(20))).toBe("a4");
  });

  it("lets an upload go after 30 minutes unused", async () => {
    const { attachments, clock, take } = store();
    const id = attachments.put("c1", "image/png", data(1));

    clock.advance(30 * 60_000 - 1);
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(1);

    await expect(take("c1", [id])).rejects.toStrictEqual(new CommandError("attachment_missing", { attachmentId: id }));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("lets a connection's uploads go when it closes, and all on close", async () => {
    const { attachments, clock, take } = store();
    const kept = attachments.put("c2", "image/png", data(1));
    attachments.put("c1", "image/png", data(1));

    attachments.drop("c1");
    expect(clock.pendingTimers()).toBe(1);
    // Another connection's upload stays.
    expect(await take("c2", [kept])).toHaveLength(1);
    const again = attachments.put("c2", "image/png", data(1));
    attachments.close();

    expect(clock.pendingTimers()).toBe(0);
    await expect(take("c2", [again])).rejects.toStrictEqual(
      new CommandError("attachment_missing", { attachmentId: again }),
    );
  });
});

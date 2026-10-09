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
  return { attachments, clock };
}

describe("createAttachmentStore", () => {
  it("keeps an upload until a message takes it, as pi's images", () => {
    const { attachments } = store();
    const id = attachments.put("c1", "image/webp", data(10));

    expect(id).toBe("a1");
    expect(attachments.take("c1", [id])).toStrictEqual([{ data: data(10), mimeType: "image/webp" }]);
    expect(() => attachments.take("c1", [id])).toThrow(new CommandError("attachment_missing", { attachmentId: "a1" }));
  });

  it("gives a connection only its own uploads, and takes none when one is missing", () => {
    const { attachments } = store();
    const mine = attachments.put("c1", "image/png", data(1));
    const theirs = attachments.put("c2", "image/png", data(1));

    expect(() => attachments.take("c1", [mine, theirs])).toThrow(
      new CommandError("attachment_missing", { attachmentId: theirs }),
    );
    expect(attachments.take("c1", [mine])).toHaveLength(1);
  });

  it("refuses an upload past a connection's limit in bytes or count, counting what was taken off", () => {
    const { attachments } = store({ bytes: 30, count: 2 });
    const first = attachments.put("c1", "image/png", data(20));

    expect(() => attachments.put("c1", "image/png", data(11))).toThrow(new CommandError("attachment_limit"));
    attachments.put("c1", "image/png", data(10));
    expect(() => attachments.put("c1", "image/png", data(1))).toThrow(new CommandError("attachment_limit"));
    attachments.put("c2", "image/png", data(30));
    attachments.take("c1", [first]);
    expect(attachments.put("c1", "image/png", data(20))).toBe("a4");
  });

  it("lets an upload go after 30 minutes unused", () => {
    const { attachments, clock } = store();
    const id = attachments.put("c1", "image/png", data(1));

    clock.advance(30 * 60_000 - 1);
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(1);

    expect(() => attachments.take("c1", [id])).toThrow(new CommandError("attachment_missing", { attachmentId: id }));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("lets a connection's uploads go when it closes, and all on close", () => {
    const { attachments, clock } = store();
    const kept = attachments.put("c2", "image/png", data(1));
    attachments.put("c1", "image/png", data(1));

    attachments.drop("c1");
    expect(clock.pendingTimers()).toBe(1);
    attachments.close();

    expect(clock.pendingTimers()).toBe(0);
    expect(() => attachments.take("c2", [kept])).toThrow(
      new CommandError("attachment_missing", { attachmentId: kept }),
    );
  });
});

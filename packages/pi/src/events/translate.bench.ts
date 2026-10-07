import { compareWithBaseline } from "@atrium/testkit";
import { expect, test } from "vitest";
import type { PiEvent } from "../process/pi-process";
import { createEventTranslator } from "./translate";

/** One streamed reply of 5000 deltas, as pi prints it. */
const EVENTS = [
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  ...Array.from({ length: 5_000 }, () => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed 文字 " },
  })),
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "…" }], stopReason: "stop", timestamp: 0 },
  },
] as unknown as PiEvent[];

/** Translates the whole reply with a fresh translator. */
function translateAll(): void {
  let next = 0;
  const translate = createEventTranslator(() => `m${++next}`);
  for (const event of EVENTS) translate(event);
}

test("translating a streamed reply stays near its baseline speed", async ({ bench }) => {
  const ratio = await compareWithBaseline(bench, "translate reply", ".bench/pi/translate-reply.json", translateAll);

  expect(ratio).toBeLessThan(3);
});

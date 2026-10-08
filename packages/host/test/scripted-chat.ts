import type { ScriptedRule } from "@atrium/testkit";

/** What pi prints for one prompt, "ping", that it answers with "pong". */
export const PONG_TURN: readonly object[] = [
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 } },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pong" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      stopReason: "stop",
      usage: { input: 3, output: 1 },
      timestamp: 2,
    },
  },
  { type: "agent_settled" },
];

/** pi's answers to `get_entries`: no entries at first, then the two messages of `PONG_TURN` as pi writes them. */
export const PONG_ENTRIES: ScriptedRule = {
  sequence: [
    { data: { entries: [], leafId: null } },
    {
      data: {
        entries: [
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: "2026-10-08T00:00:00.001Z",
            message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: "2026-10-08T00:00:00.002Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "pong" }],
              stopReason: "stop",
              usage: { input: 3, output: 1 },
              timestamp: 2,
            },
          },
        ],
        leafId: "a1",
      },
    },
  ],
};

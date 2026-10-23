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

/**
 * pi's answer to `get_session_stats` after `PONG_TURN`: one message each way.
 *
 * @remarks
 * Without a rule the scripted pi answers with no data, which the host cannot read and warns
 * about, so the log gate would fail on the test double rather than on the host (testing.md,
 * "日志门禁").
 */
export const PONG_STATS: ScriptedRule = {
  data: {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    totalMessages: 2,
    tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, total: 4 },
    cost: 0,
  },
};

/**
 * pi's answer to `get_session_stats` for tests that check the exact order of a session's events:
 * none, as if the read were still under way.
 *
 * @remarks
 * Figures would bring a `metrics_updated` whenever the read lands, which such tests do not expect;
 * a read still waiting is dropped without a warning when pi stops (see `PONG_STATS`).
 */
export const UNANSWERED_STATS: ScriptedRule = { silent: true };

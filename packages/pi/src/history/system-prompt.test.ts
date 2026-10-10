import { type Message, type SystemMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, estimateTokens } from "@earendil-works/pi-coding-agent";
import { type FixtureRecord, type JsonObject, parseFixture, present } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import { type LogEntry, toLogEntry } from "./log-entry";
import { contextShares } from "./system-prompt";

/** A system message entry with the fields a test gives. */
function systemEntry(id: string, message: Partial<SystemMessage>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    message: { role: "system", content: "", timestamp: 0, ...message },
  };
}

/** A user message entry, which says nothing of the system prompt. */
function userEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    message: { role: "user", content: "x".repeat(400), timestamp: 0 },
  };
}

/** A compaction entry that stored the system prompt as `systemMessage`, or none. */
function compactionEntry(id: string, systemMessage?: SystemMessage): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    summary: "",
    firstKeptEntryId: id,
    tokensBefore: 0,
    ...(systemMessage === undefined ? {} : { systemMessage }),
  };
}

/**
 * What pi's own functions make of a list of system messages.
 *
 * @remarks
 * pi-ai's `getCurrentSystemMessage` replays them; the prompt is estimated as pi's `estimateTokens`
 * counts it, and the tools apart, so the host's split can be checked whole.
 *
 * @sideEffects none
 * @param messages - The system messages, in order.
 * @returns The prompt's and the tools' tokens, and pi's estimate of the two together.
 */
function piShares(messages: readonly SystemMessage[]): { system: number; tools: number; together: number } {
  const current = present(getCurrentSystemMessage(messages as Message[]), "a system message");
  const text = typeof current.content === "string" ? current.content : "";
  const sections = Object.values(current.sections ?? {}).reduce((sum, section) => sum + (section?.length ?? 0), 0);
  const tools = current.toolsAdded === undefined ? 0 : JSON.stringify(current.toolsAdded).length;
  return {
    system: Math.ceil((text.length + sections) / 4),
    tools: Math.ceil(tools / 4),
    together: estimateTokens(current),
  };
}

/**
 * A recorded `get_entries` answer, if the record is one.
 *
 * @sideEffects none
 * @param record - A fixture record.
 * @returns The answer, or nothing.
 */
function entriesAnswer(record: FixtureRecord): JsonObject[] {
  return record.kind === "stdout" && record.record["command"] === "get_entries" ? [record.record] : [];
}

/**
 * An entry's system message, if it holds one.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns The message, or nothing.
 */
function systemMessageOf(entry: SessionEntry): SystemMessage[] {
  return entry.type === "message" && entry.message.role === "system" ? [entry.message] : [];
}

const READ = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const BASH = { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } };
const GREP = { name: "grep", description: "Search", parameters: { type: "object" } };

describe("contextShares", () => {
  it("replays the system messages as pi does: text added on, sections by name, tools added and taken away", () => {
    const messages: SystemMessage[] = [
      {
        role: "system",
        content: "base prompt",
        sections: { preamble: "p".repeat(101), cwd: "/w", skills: "s".repeat(37) },
        toolsAdded: [READ, BASH],
        timestamp: 0,
      },
      { role: "system", content: "", sections: { cwd: "/elsewhere", skills: null }, timestamp: 0 },
      {
        role: "system",
        content: [
          { type: "text", text: "more" },
          { type: "text", text: "rules" },
        ],
        toolsAdded: [GREP, { ...READ, description: "Read a file, any file" }],
        toolsRemoved: [{ name: "bash" }],
        timestamp: 0,
      },
    ];
    const entries = messages.map((message, index) => toLogEntry(systemEntry(`s${index}`, message)));

    const shares = contextShares(entries);
    const pi = piShares(messages);

    expect(shares).toStrictEqual({ system: pi.system, tools: pi.tools });
    expect(shares).toStrictEqual({ system: 34, tools: 43 });
    expect(pi.together).toBe(77);
  });

  it("starts again from the system prompt the latest compaction stored", () => {
    const before: SystemMessage = { role: "system", content: "old", sections: { a: "a".repeat(40) }, timestamp: 0 };
    const stored: SystemMessage = { role: "system", content: "new", sections: { b: "b".repeat(9) }, timestamp: 0 };
    const after: SystemMessage = { role: "system", content: "", toolsAdded: [GREP], timestamp: 0 };
    const entries = [
      systemEntry("s0", before),
      userEntry("u0"),
      compactionEntry("c0", stored),
      userEntry("u1"),
      systemEntry("s1", after),
    ].map(toLogEntry);

    expect(contextShares(entries)).toStrictEqual({
      system: piShares([stored, after]).system,
      tools: piShares([stored, after]).tools,
    });
    expect(contextShares(entries)).toStrictEqual({ system: 3, tools: 18 });
  });

  it("goes on from the start past a compaction that stored no system prompt, as before pi stored one", () => {
    const first: SystemMessage = { role: "system", content: "c".repeat(20), timestamp: 0 };
    const entries = [systemEntry("s0", first), compactionEntry("c0"), userEntry("u0")].map(toLogEntry);

    expect(contextShares(entries)).toStrictEqual({ system: 5, tools: 0 });
  });

  it("knows nothing before pi stated a system prompt", () => {
    expect(contextShares([])).toBeNull();
    expect(contextShares([userEntry("u0"), compactionEntry("c0")].map(toLogEntry))).toBeNull();
  });

  it("agrees with pi on the recorded session's system prompt", () => {
    const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.1.0", "history.jsonl"), "utf8"));
    const answer = fixture.flatMap(entriesAnswer);
    const { entries } = present(answer.at(-1), "the last get_entries answer")["data"] as unknown as {
      entries: SessionEntry[];
    };
    const system = entries.flatMap(systemMessageOf);
    const logged: LogEntry[] = entries.map(toLogEntry);

    expect(contextShares(logged)).toStrictEqual({ system: piShares(system).system, tools: piShares(system).tools });
  });
});

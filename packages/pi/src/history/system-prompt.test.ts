import { type Message, type SystemMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, estimateTokens } from "@earendil-works/pi-coding-agent";
import { type FixtureRecord, type JsonObject, parseFixture, present } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import { type LogEntry, toLogEntry } from "./log-entry";
import { contextParts } from "./system-prompt";

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
 * counts it, so the host's replay can be checked against pi's.
 *
 * @sideEffects none
 * @param messages - The system messages, in order.
 * @returns The prompt's tokens, its tools' names in order, and pi's estimate of the whole.
 */
function piPrompt(messages: readonly SystemMessage[]): { system: number; tools: string[]; together: number } {
  const current = present(getCurrentSystemMessage(messages as Message[]), "a system message");
  const text = typeof current.content === "string" ? current.content : "";
  const sections = Object.values(current.sections ?? {}).reduce((sum, section) => sum + (section?.length ?? 0), 0);
  return {
    system: Math.ceil((text.length + sections) / 4),
    tools: (current.toolsAdded ?? []).map(({ name }) => name),
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

/** A tool's declaration with a description `size` characters long. */
const tool = (name: string, size = 10) => ({
  name,
  description: "d".repeat(size),
  parameters: { type: "object", properties: {} },
});

/** A tool's estimated tokens: its declaration's JSON, a token for four characters. */
const tokensOf = (declaration: object) => Math.ceil(JSON.stringify(declaration).length / 4);

const READ = tool("read");
const BASH = tool("bash", 30);
const GREP = tool("grep", 3);
const CLICK = tool("mcp__chrome-devtools__click", 41);
const FILL = tool("mcp__chrome-devtools__fill", 7);
const LIST = tool("mcp__paseo__list", 22);
const TODO = tool("todo", 18);

/** The memory files' section, as pi writes it, and its pieces. */
const GLOBAL = `<project_instructions path="/home/me/.pi/agent/AGENTS.md">\n${"g".repeat(30)}\n</project_instructions>`;
const PROJECT = `<project_instructions path="/work/atrium/AGENTS.md">\n${"p".repeat(200)}\n</project_instructions>`;
const MEMORY = `Project-specific instructions and guidelines:\n\n${GLOBAL}\n\n${PROJECT}`;

/** The skills' section, and its pieces. */
const TDD = "<skill>\n<name>tdd</name>\n<description>Test first</description>\n</skill>";
const DIAGNOSE = `<skill>\n<name>diagnose</name>\n<description>${"x".repeat(60)}</description>\n</skill>`;
const SKILLS = `<available_skills>\n${TDD}\n${DIAGNOSE}\n</available_skills>`;

/** A system message with a text, an addendum and every other kind of section, besides `sections`. */
const promptWith = (sections: SystemMessage["sections"]): LogEntry[] => [
  toLogEntry(
    systemEntry("s0", {
      content: "c".repeat(6),
      sections: {
        addendum: "a".repeat(10),
        cwd: "/w".repeat(2),
        project_context: MEMORY,
        skills: SKILLS,
        mcp_servers: "m".repeat(40),
        todo_list: "l".repeat(21),
        ...sections,
      },
      toolsAdded: [READ, CLICK, TODO],
    }),
  ),
];
/** pi's default opening, with its tools, rules and docs. */
const DEFAULT = { preamble: "p".repeat(40), tools: "t".repeat(8), rules: "r".repeat(12), docs: "d".repeat(20) };

describe("contextParts", () => {
  it("replays the system messages as pi does: text added on, sections by name, tools added and taken away", () => {
    const messages: SystemMessage[] = [
      {
        role: "system",
        content: "base prompt",
        sections: { preamble: "p".repeat(101), cwd: "/w", skills: "s".repeat(37), rules: "r".repeat(9) },
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

    const parts = present(contextParts(entries), "the parts");
    const pi = piPrompt(messages);

    expect(parts.system).toBe(pi.system);
    expect(parts.system).toBe(36);
    expect(parts.builtin.items.map(({ name }) => name).toSorted()).toStrictEqual(pi.tools.toSorted());
    expect(parts.builtin).toStrictEqual({
      tokens: Math.ceil(
        (JSON.stringify(GREP).length + JSON.stringify({ ...READ, description: "Read a file, any file" }).length) / 4,
      ),
      items: [
        { name: "read", tokens: tokensOf({ ...READ, description: "Read a file, any file" }) },
        { name: "grep", tokens: tokensOf(GREP) },
      ],
    });
    expect(parts.skills).toStrictEqual({ tokens: 0, items: [] });
  });

  it("splits the prompt into the system prompt, memory files, skills, built-in, MCP and extension tools", () => {
    const message: SystemMessage = {
      role: "system",
      content: "",
      sections: {
        preamble: "p".repeat(40),
        tools: "t".repeat(8),
        rules: "r".repeat(12),
        docs: "d".repeat(20),
        addendum: "a".repeat(4),
        cwd: "/w".repeat(2),
        project_context: MEMORY,
        skills: SKILLS,
        mcp_servers: "m".repeat(40),
        todo_list: "l".repeat(21),
      },
      toolsAdded: [READ, BASH, tool("codemode", 5), tool("tool_search", 1), CLICK, FILL, LIST, TODO],
      timestamp: 0,
    };

    const parts = contextParts([toLogEntry(systemEntry("s0", message))]);

    const mcpChars = [CLICK, FILL, LIST].reduce((total, declaration) => total + JSON.stringify(declaration).length, 0);
    const chromeChars = JSON.stringify(CLICK).length + JSON.stringify(FILL).length;
    expect(parts).toStrictEqual({
      system: Math.ceil((40 + 8 + 12 + 20 + 4 + 4) / 4),
      memory: {
        tokens: Math.ceil(MEMORY.length / 4),
        files: [
          { path: "/work/atrium/AGENTS.md", tokens: Math.ceil(PROJECT.length / 4) },
          { path: "/home/me/.pi/agent/AGENTS.md", tokens: Math.ceil(GLOBAL.length / 4) },
        ],
      },
      skills: {
        tokens: Math.ceil(SKILLS.length / 4),
        items: [
          { name: "diagnose", tokens: Math.ceil(DIAGNOSE.length / 4) },
          { name: "tdd", tokens: Math.ceil(TDD.length / 4) },
        ],
      },
      builtin: {
        tokens: Math.ceil(
          [READ, BASH, tool("codemode", 5), tool("tool_search", 1)].reduce(
            (total, declaration) => total + JSON.stringify(declaration).length,
            0,
          ) / 4,
        ),
        items: [
          { name: "bash", tokens: tokensOf(BASH) },
          { name: "read", tokens: tokensOf(READ) },
          { name: "codemode", tokens: tokensOf(tool("codemode", 5)) },
          { name: "tool_search", tokens: tokensOf(tool("tool_search", 1)) },
        ],
      },
      mcp: {
        tokens: Math.ceil((mcpChars + 40) / 4),
        servers: [
          { name: "chrome-devtools", tools: 2, tokens: Math.ceil(chromeChars / 4) },
          { name: "paseo", tools: 1, tokens: tokensOf(LIST) },
        ],
      },
      extensions: {
        tokens: Math.ceil((JSON.stringify(TODO).length + 21) / 4),
        items: [
          { name: "todo", tokens: tokensOf(TODO) },
          { name: "todo_list", tokens: 6 },
        ],
      },
    });
  });

  describe("through Claude Code", () => {
    it("counts Claude Code's own prompt, the text and the addendum, not pi's opening, tools, rules, docs and cwd", () => {
      const entries = promptWith(DEFAULT);

      const parts = present(contextParts(entries, "claude-bridge"), "the parts");

      expect(parts.system).toBe(Math.ceil((15_300 + 6 + 10) / 4));
      expect({ ...parts, system: 0 }).toStrictEqual({ ...present(contextParts(entries), "pi's parts"), system: 0 });
    });

    it("counts an opening of your own, which pi writes with no docs", () => {
      const parts = contextParts(promptWith({ preamble: "y".repeat(80) }), "claude-bridge");

      expect(parts?.system).toBe(Math.ceil((15_300 + 80 + 6 + 10) / 4));
    });

    it("counts pi's prompt for any other provider, as for none", () => {
      const entries = promptWith(DEFAULT);

      expect(contextParts(entries, "anthropic")).toStrictEqual(contextParts(entries));
      expect(contextParts(entries, null)?.system).toBe(Math.ceil((6 + 40 + 8 + 12 + 20 + 10 + 4) / 4));
    });
  });

  it("takes each of pi's own tools as built-in, and a name with mcp__ not at its start as an extension's", () => {
    const own = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "tool_search"];
    const message: SystemMessage = {
      role: "system",
      content: "",
      toolsAdded: [...own, "x_mcp__a__b"].map((name) => tool(name)),
      timestamp: 0,
    };

    const parts = contextParts([toLogEntry(systemEntry("s0", message))]);

    expect(parts?.builtin.items.map(({ name }) => name).toSorted()).toStrictEqual(own.toSorted());
    expect([parts?.extensions.items.map(({ name }) => name), parts?.mcp.servers]).toStrictEqual([["x_mcp__a__b"], []]);
  });

  it("puts a tool named like MCP's without a tool after the server among the extensions", () => {
    const odd = tool("mcp__alone", 2);
    const parts = contextParts([toLogEntry(systemEntry("s0", { toolsAdded: [odd, tool("mcp____x", 2)] }))]);

    expect(parts?.extensions.items.map(({ name }) => name)).toStrictEqual(["mcp____x", "mcp__alone"]);
    expect(parts?.mcp).toStrictEqual({ tokens: 0, servers: [] });
  });

  it("keeps a split section's pieces until a later message replaces or removes the section", () => {
    const first: SystemMessage = {
      role: "system",
      content: "",
      sections: { project_context: MEMORY, skills: SKILLS },
      timestamp: 0,
    };
    const second: SystemMessage = {
      role: "system",
      content: "",
      sections: { project_context: `Project-specific instructions and guidelines:\n\n${GLOBAL}`, skills: null },
      timestamp: 0,
    };
    const later: SystemMessage = { role: "system", content: "", sections: { cwd: "/w" }, timestamp: 0 };

    const parts = contextParts(
      [first, second, later].map((message, index) => toLogEntry(systemEntry(`s${index}`, message))),
    );

    expect(parts?.memory.files).toStrictEqual([
      { path: "/home/me/.pi/agent/AGENTS.md", tokens: Math.ceil(GLOBAL.length / 4) },
    ]);
    expect(parts?.skills).toStrictEqual({ tokens: 0, items: [] });
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

    const parts = contextParts(entries);

    expect(parts?.system).toBe(1);
    expect(parts?.extensions).toStrictEqual({ tokens: 3, items: [{ name: "b", tokens: 3 }] });
    expect(parts?.builtin).toStrictEqual({ tokens: tokensOf(GREP), items: [{ name: "grep", tokens: tokensOf(GREP) }] });
  });

  it("goes on from the start past a compaction that stored no system prompt, as before pi stored one", () => {
    const first: SystemMessage = { role: "system", content: "c".repeat(20), timestamp: 0 };
    const entries = [systemEntry("s0", first), compactionEntry("c0"), userEntry("u0")].map(toLogEntry);

    expect(contextParts(entries)?.system).toBe(5);
  });

  it("knows nothing before pi stated a system prompt", () => {
    expect(contextParts([])).toBeNull();
    expect(contextParts([userEntry("u0"), compactionEntry("c0")].map(toLogEntry))).toBeNull();
  });

  it("agrees with pi on the recorded session's system prompt", () => {
    const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.1.0", "history.jsonl"), "utf8"));
    const answer = fixture.flatMap(entriesAnswer);
    const { entries } = present(answer.at(-1), "the last get_entries answer")["data"] as unknown as {
      entries: SessionEntry[];
    };
    const system = entries.flatMap(systemMessageOf);
    const logged: LogEntry[] = entries.map(toLogEntry);
    const parts = present(contextParts(logged), "the parts");

    expect(parts.system).toBe(piPrompt(system).system);
    expect(parts.builtin.items.map(({ name }) => name).toSorted()).toStrictEqual(piPrompt(system).tools.toSorted());
    expect([parts.memory, parts.skills, parts.mcp, parts.extensions]).toStrictEqual([
      { tokens: 0, files: [] },
      { tokens: 0, items: [] },
      { tokens: 0, servers: [] },
      { tokens: 0, items: [] },
    ]);
  });
});

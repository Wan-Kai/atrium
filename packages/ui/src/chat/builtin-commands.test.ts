import type { CatalogModel, Step, TranscriptItem, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  builtinBlocked,
  builtinCall,
  lastReply,
  namedLevel,
  namedModel,
  tagPlaceholder,
} from "./builtin-commands";

/** The built-in called `name`. */
function builtin(name: string) {
  return BUILTIN_COMMANDS.find((one) => one.name === name);
}

describe("BUILTIN_COMMANDS", () => {
  it("are SPEC's table: name, argument, description, and whether each runs while busy and before the first message", () => {
    expect(
      BUILTIN_COMMANDS.map(({ source, name, hint, description, whileRunning, inDraft }) => [
        source,
        name,
        hint,
        description,
        whileRunning,
        inDraft,
      ]),
    ).toStrictEqual([
      ["builtin", "compact", "要求", "压缩上下文", false, false],
      ["builtin", "model", "服务商/模型", "切换模型", true, true],
      ["builtin", "thinking", "档位", "推理强度", true, true],
      ["builtin", "copy", null, "复制最后一条回复", true, true],
    ]);
  });
});

describe("builtinCall", () => {
  it("is a built-in's tag with the text as its argument, trimmed", () => {
    expect(builtinCall("  openai/gpt-5 ", { source: "builtin", name: "model" })).toStrictEqual({
      command: builtin("model"),
      args: "openai/gpt-5",
    });
    expect(builtinCall("", { source: "builtin", name: "copy" })).toStrictEqual({ command: builtin("copy"), args: "" });
  });

  it("is a built-in's /name typed out, followed by a space or nothing", () => {
    expect(builtinCall("/thinking  high\n", null)).toStrictEqual({ command: builtin("thinking"), args: "high" });
    expect(builtinCall("/copy", null)).toStrictEqual({ command: builtin("copy"), args: "" });
    expect(builtinCall("/model\nopenai/gpt-5", null)).toStrictEqual({
      command: builtin("model"),
      args: "openai/gpt-5",
    });
  });

  it("is nothing for another kind's tag, another name, or a name run on", () => {
    expect(builtinCall("/model", { source: "extension", name: "model" })).toBeNull();
    expect(builtinCall("", { source: "builtin", name: "fork" })).toBeNull();
    expect(builtinCall("/models", null)).toBeNull();
    expect(builtinCall("/copy/that", null)).toBeNull();
    expect(builtinCall(" /copy", null)).toBeNull();
    expect(builtinCall("copy", null)).toBeNull();
  });
});

describe("builtinBlocked", () => {
  it("says why a command cannot run while busy or before the first message, busy first", () => {
    const neither = { whileRunning: false, inDraft: false };
    expect(builtinBlocked(neither, { busy: true, draft: true })).toBe("运行中不能用，先停止");
    expect(builtinBlocked(neither, { busy: false, draft: true })).toBe("发出第一条消息后才能用");
    expect(builtinBlocked(neither, { busy: false, draft: false })).toBeNull();
  });

  it("lets a command run where it can", () => {
    expect(builtinBlocked({ whileRunning: true, inDraft: false }, { busy: true, draft: false })).toBeNull();
    expect(builtinBlocked({ whileRunning: false, inDraft: true }, { busy: false, draft: true })).toBeNull();
  });
});

describe("tagPlaceholder", () => {
  it("offers a built-in's argument as optional, says Enter runs one without, and asks for words after others", () => {
    expect(tagPlaceholder({ source: "builtin", name: "model" })).toBe("服务商/模型（可选）");
    expect(tagPlaceholder({ source: "builtin", name: "copy" })).toBe("回车执行");
    expect(tagPlaceholder({ source: "builtin", name: "gone" })).toBe("回车执行");
    expect(tagPlaceholder({ source: "skill", name: "skill:review" })).toBe("接着写要说的话（可选）");
    expect(tagPlaceholder({ source: "prompt", name: "model" })).toBe("接着写要说的话（可选）");
  });
});

/** A model in a container's list. */
function model(providerId: string, modelId: string): CatalogModel {
  return {
    providerId,
    modelId,
    name: modelId,
    contextWindow: 1,
    maxOutput: 1,
    supportsImage: false,
    thinkingLevels: ["off"],
    fast: null,
  };
}

describe("namedModel", () => {
  it("finds the model written as provider/model, its id holding / too", () => {
    const models = [model("openai", "gpt-5"), model("openrouter", "z-ai/glm-5")];
    expect(namedModel("openai/gpt-5", models)).toStrictEqual({ providerId: "openai", modelId: "gpt-5" });
    expect(namedModel("openrouter/z-ai/glm-5", models)).toStrictEqual({
      providerId: "openrouter",
      modelId: "z-ai/glm-5",
    });
  });

  it("finds nothing for a name not listed whole", () => {
    const models = [model("openai", "gpt-5")];
    expect(namedModel("gpt-5", models)).toBeNull();
    expect(namedModel("openai/gpt", models)).toBeNull();
    expect(namedModel("anthropic/gpt-5", models)).toBeNull();
  });
});

describe("namedLevel", () => {
  it("is a level the model supports, or any of pi's when its levels are unknown", () => {
    expect(namedLevel("high", ["off", "low", "high"])).toStrictEqual({ level: "high" });
    expect(namedLevel("max", [])).toStrictEqual({ level: "max" });
  });

  it("says when there is no such level, or the model does not support it", () => {
    expect(namedLevel("hard", ["off", "high"])).toStrictEqual({ problem: "没有这个档位" });
    expect(namedLevel("", [])).toStrictEqual({ problem: "没有这个档位" });
    expect(namedLevel("xhigh", ["off", "high"])).toStrictEqual({ problem: "当前模型不支持这个档位" });
  });
});

/** A turn with these steps and outcome. */
function turn(id: string, steps: Step[], outcome: Turn["outcome"] = "done"): Turn {
  return {
    kind: "turn",
    id,
    user: { text: "q", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps,
    outcome,
    error: null,
    startedAt: 0,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

describe("lastReply", () => {
  it("is the reply of the last turn that has one and is not running", () => {
    const items: TranscriptItem[] = [
      turn("t1", [{ kind: "text", id: "s1", text: "first" }]),
      turn("t2", [{ kind: "text", id: "s2", text: "**second**" }], "stopped"),
      turn("t3", [
        { kind: "text", id: "s3", text: "before" },
        {
          kind: "tool",
          id: "s4",
          callId: "c1",
          tool: "bash",
          args: {},
          status: "failed",
          output: null,
          details: null,
          partial: false,
        },
      ]),
      { kind: "notice", id: "n1", notice: "restarted", attempt: 1, timestamp: 0 },
      turn("t4", [{ kind: "text", id: "s5", text: "half" }], "running"),
    ];
    expect(lastReply(items)).toBe("**second**");
  });

  it("is nothing before any reply", () => {
    expect(lastReply([])).toBeNull();
    expect(lastReply([turn("t1", [])])).toBeNull();
  });
});

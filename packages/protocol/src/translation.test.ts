import { describe, expect, it } from "vitest";
import { Command, CommandResult } from "./commands";
import { ErrorCode } from "./errors";
import { Preferences } from "./listing";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const fields = { requestId: "request-1", traceparent };

describe("reply translation protocol", () => {
  it("validates a saved target language without changing other preferences", () => {
    const command = { type: "set_preferences", ...fields, translationLanguage: "  简体中文  " };
    expect(Command.parse(command)).toStrictEqual({ ...command, translationLanguage: "简体中文" });
    expect(Command.safeParse({ ...command, translationLanguage: "English" }).success).toBe(true);
    expect(Command.safeParse({ ...command, translationLanguage: "语".repeat(80) }).success).toBe(true);
    for (const translationLanguage of ["", "   ", "a".repeat(81), "English\n", "中\u0000文", "en\u0085"]) {
      expect(Command.safeParse({ ...command, translationLanguage }).success).toBe(false);
    }
    const preferences = {
      setupDone: false,
      appearance: "system",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
      translationLanguage: "日本語",
    };
    expect(Preferences.parse(preferences)).toStrictEqual(preferences);
    expect(Preferences.safeParse({ ...preferences, translationLanguage: "" }).success).toBe(false);
  });

  it("validates translated text with the captured language and model", () => {
    const result = { text: "译文", language: "简体中文", model: { providerId: "faux", modelId: "faux-1" } };
    expect(CommandResult["translate_reply"].parse(result)).toStrictEqual(result);
    expect(CommandResult["translate_reply"].safeParse({ ...result, text: "" }).success).toBe(false);
    expect(CommandResult["translate_reply"].safeParse({ ...result, text: "a".repeat(512 * 1024 + 1) }).success).toBe(
      false,
    );
    expect(CommandResult["translate_reply"].safeParse({ ...result, model: null }).success).toBe(false);
    expect(CommandResult["translate_reply"].safeParse({ ...result, language: "" }).success).toBe(false);
    expect(CommandResult["cancel_translation"].parse({})).toStrictEqual({});
    expect(ErrorCode.parse("translation_failed")).toBe("translation_failed");
  });

  it("accepts a reply reference and cancellation without accepting client-supplied content or model", () => {
    const command = { type: "translate_reply", ...fields, sessionId: "s1", turnId: "s1:u1", translationId: "tr-1" };
    expect(Command.parse(command)).toStrictEqual(command);
    expect(Command.safeParse({ ...command, text: "untrusted" }).success).toBe(false);
    expect(Command.safeParse({ ...command, model: { providerId: "faux", modelId: "other" } }).success).toBe(false);
    expect(Command.safeParse({ ...command, language: "English" }).success).toBe(false);
    expect(Command.safeParse({ ...command, translationId: "" }).success).toBe(false);
    expect(Command.safeParse({ ...command, translationId: "x".repeat(129) }).success).toBe(false);
    const cancel = { type: "cancel_translation", ...fields, translationId: "tr-1" };
    expect(Command.parse(cancel)).toStrictEqual(cancel);
    expect(Command.safeParse({ ...cancel, translationId: "" }).success).toBe(false);
  });
});

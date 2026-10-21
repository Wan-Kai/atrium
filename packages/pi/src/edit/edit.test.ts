import { describe, expect, it } from "vitest";
import { EDIT_COMMAND, editCommand, readEditParams } from "./edit";

describe("edit command arguments", () => {
  it("encodes only the rewind ids and nullable leaf, and restore token", () => {
    for (const action of [
      { action: "rewind", token: "op-1", entryId: "u1", leafId: null },
      { action: "restore", token: "op-1" },
    ] as const) {
      const command = editCommand(action);
      expect(command.startsWith(`/${EDIT_COMMAND} `)).toBe(true);
      expect(JSON.parse(Buffer.from(command.slice(EDIT_COMMAND.length + 2), "base64url").toString())).toStrictEqual(
        action,
      );
    }
  });

  it("bounds encoded length and rejects noncanonical spelling and malformed JSON", () => {
    const params = { action: "restore", token: "op1" } as const;
    const text = JSON.stringify(params);
    expect(readEditParams(Buffer.from(text.padStart(768, " ")).toString("base64url"))).toStrictEqual(params);
    expect(readEditParams(Buffer.from(text.padStart(769, " ")).toString("base64url"))).toBeNull();
    const encoded = Buffer.from(text).toString("base64url");
    expect(readEditParams(`!${encoded}`)).toBeNull();
    expect(readEditParams(`${encoded}!`)).toBeNull();
    expect(readEditParams("ew")).toBeNull();
    // JSON has 34 bytes; the final base64 sextet has four unused bits.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical =
      encoded.slice(0, -1) + alphabet.charAt(alphabet.indexOf(encoded.charAt(encoded.length - 1)) + 1);
    expect(Buffer.from(noncanonical, "base64url").toString()).toBe(text);
    expect(readEditParams(noncanonical)).toBeNull();
  });

  it.each([
    { action: "rewind", token: "", entryId: "u", leafId: null },
    { action: "rewind", token: "op", entryId: "u", leafId: 1 },
    { action: "restore", token: "x".repeat(129) },
    { action: "restore", token: "op", text: "private" },
    { action: "restore", token: " op" },
    { action: "restore", token: "op " },
  ])("rejects malformed or content-bearing parameters: %j", (params) => {
    expect(() => editCommand(params as Parameters<typeof editCommand>[0])).toThrow(Error);
  });
});

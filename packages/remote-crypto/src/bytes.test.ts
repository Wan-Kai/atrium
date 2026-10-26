import { describe, expect, it } from "vitest";
import { fromBase64Url, fromHex, fromUtf8, toBase64Url, toHex, utf8 } from "./bytes";

describe("hex", () => {
  it("reads and writes lower-case hex, and also reads upper case", () => {
    expect(fromHex("00ffAb")).toStrictEqual(Uint8Array.of(0x00, 0xff, 0xab));
    expect(fromHex("")).toStrictEqual(new Uint8Array(0));
    expect(toHex(Uint8Array.of(0x00, 0xff, 0xab))).toBe("00ffab");
    // A view into a larger buffer writes only its own bytes.
    expect(toHex(Uint8Array.of(1, 2, 3, 4).subarray(1, 3))).toBe("0203");
  });

  it("refuses odd lengths and non-hex characters anywhere", () => {
    expect(() => fromHex("abc")).toThrow("not hex");
    expect(() => fromHex("zz00")).toThrow("not hex");
    expect(() => fromHex("00zz")).toThrow("not hex");
    expect(() => fromHex("0 ")).toThrow("not hex");
  });
});

describe("base64url", () => {
  it("writes base64url without padding, only the view's bytes", () => {
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(toBase64Url(Uint8Array.of(9, 0xfb, 0xff, 9).subarray(1, 3))).toBe("-_8");
  });

  it("reads canonical text of the right length", () => {
    expect(fromBase64Url("-_8", 2)).toStrictEqual(Uint8Array.of(0xfb, 0xff));
  });

  it("refuses the wrong length, padding, standard base64 and non-canonical trailing bits", () => {
    expect(() => fromBase64Url("-_8", 3)).toThrow("bad base64url");
    expect(() => fromBase64Url("-_8=", 2)).toThrow("bad base64url");
    expect(() => fromBase64Url("+/8", 2)).toThrow("bad base64url");
    expect(() => fromBase64Url("-_9", 2)).toThrow("bad base64url");
  });
});

describe("UTF-8", () => {
  it("round-trips text and refuses invalid sequences", () => {
    expect(utf8("猫")).toStrictEqual(Uint8Array.of(0xe7, 0x8c, 0xab));
    expect(fromUtf8(Uint8Array.of(0xe7, 0x8c, 0xab))).toBe("猫");
    expect(() => fromUtf8(Uint8Array.of(0xe7, 0x8c))).toThrow(TypeError);
  });
});

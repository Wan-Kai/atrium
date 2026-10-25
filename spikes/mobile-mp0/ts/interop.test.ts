import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRecord, type InteropRecord, replayRecord, tsInputs } from "./interop.ts";

const INTEROP_DIR = new URL("../interop/", import.meta.url);

/**
 * Reads a record from the interop folder.
 *
 * @sideEffects Reads the file.
 * @param name - File name.
 * @returns The record.
 */
function read(name: string): InteropRecord {
  return JSON.parse(readFileSync(new URL(name, INTEROP_DIR), "utf8")) as InteropRecord;
}

const swiftFiles = readdirSync(INTEROP_DIR).filter((name) => /^swift-.*\.json$/.test(name));

describe("TypeScript records", () => {
  it("are what interop.ts generates now (run `node interop.ts` after changing it)", () => {
    const { ik, ikpsk2 } = tsInputs();
    expect(read("ts-ik.json")).toStrictEqual(buildRecord(ik));
    expect(read("ts-ikpsk2.json")).toStrictEqual(buildRecord(ikpsk2));
  });

  it("replay cleanly, both regenerated and read independently", () => {
    expect(replayRecord(read("ts-ik.json"))).toStrictEqual([]);
    expect(replayRecord(read("ts-ikpsk2.json"))).toStrictEqual([]);
  });

  it("cover a two-chunk message with a pong between its chunks", () => {
    const record = read("ts-ik.json");
    expect(
      record.transport.filter((entry) => entry.from === "host").map((entry) => entry.plaintext.slice(0, 2)),
    ).toStrictEqual(["00", "00", "01", "03", "00", "04"]);
    expect(record.decoded.map((entry) => `${entry.from}:${entry.kind}`)).toStrictEqual([
      "phone:message",
      "host:message",
      "phone:message",
      "host:message",
      "phone:ping",
      "host:pong",
      "host:message",
      "host:control",
    ]);
  });

  it("catch a single changed byte anywhere that matters", () => {
    const record = read("ts-ikpsk2.json");
    const flip = (hex: string, at: number) =>
      hex.slice(0, at * 2) +
      (Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16) ^ 1).toString(16).padStart(2, "0") +
      hex.slice(at * 2 + 2);
    const cases: ((copy: InteropRecord) => void)[] = [
      (copy) => (copy.handshake[0].wire = flip(copy.handshake[0].wire, 2)),
      (copy) => (copy.handshake[0].noise_message = flip(copy.handshake[0].noise_message, 40)),
      (copy) => (copy.handshake[1].wire = flip(copy.handshake[1].wire, 50)),
      (copy) => (copy.transport[1]!.ciphertext = flip(copy.transport[1]!.ciphertext, 0)),
      (copy) => (copy.prologue = flip(copy.prologue, 3)),
      (copy) => (copy.psk = flip(copy.psk as string, 0)),
      (copy) => (copy.handshake_hash = flip(copy.handshake_hash, 31)),
      (copy) => (copy.sas = copy.sas === "000000" ? "000001" : "000000"),
    ];
    for (const change of cases) {
      const copy = structuredClone(record);
      change(copy);
      expect(replayRecord(copy)).not.toStrictEqual([]);
    }
  });
});

describe("Swift records", () => {
  if (swiftFiles.length === 0) {
    it.skip("none yet: the Swift side writes swift-ik.json and swift-ikpsk2.json per FORMAT.md", () => {});
  }
  for (const name of swiftFiles) {
    it(`${name} replays byte for byte`, () => {
      const record = read(name);
      expect(record.format).toBe(1);
      expect(replayRecord(record)).toStrictEqual([]);
    });
  }
});

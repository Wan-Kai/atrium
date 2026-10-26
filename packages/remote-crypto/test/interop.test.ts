import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRecord, type InteropRecord, replayRecord, tsInputs } from "./interop";

const INTEROP_DIR = new URL("interop/", import.meta.url);

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

/**
 * Writes a TypeScript record when `UPDATE_INTEROP_RECORDS=1`.
 *
 * @remarks
 * The only way to change the records; every other run compares (the Swift side replays them).
 *
 * @sideEffects Writes the file when asked to.
 * @param name - The file.
 * @param record - What it should hold.
 */
function rewriteWhenAsked(name: string, record: InteropRecord): void {
  if (process.env["UPDATE_INTEROP_RECORDS"] === "1") {
    writeFileSync(new URL(name, INTEROP_DIR), `${JSON.stringify(record, null, 2)}\n`);
  }
}

/**
 * Flips the lowest bit of one byte of a hex string.
 *
 * @remarks
 * One changed byte anywhere that matters must make the replay fail.
 *
 * @sideEffects none
 * @param hex - The bytes as hex.
 * @param at - Which byte.
 * @returns The changed hex.
 */
function flip(hex: string, at: number): string {
  const byte = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16) ^ 1;
  return hex.slice(0, at * 2) + byte.toString(16).padStart(2, "0") + hex.slice(at * 2 + 2);
}

const swiftFiles = readdirSync(INTEROP_DIR).filter((name) => /^swift-.*\.json$/.test(name));

describe("TypeScript records", () => {
  it("are what interop.ts generates now (UPDATE_INTEROP_RECORDS=1 rewrites them)", () => {
    const { ik, ikpsk2 } = tsInputs();
    rewriteWhenAsked("ts-ik.json", buildRecord(ik));
    rewriteWhenAsked("ts-ikpsk2.json", buildRecord(ikpsk2));
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
    const cases: ((copy: InteropRecord) => void)[] = [
      (copy) => (copy.handshake[0].wire = flip(copy.handshake[0].wire, 2)),
      (copy) => (copy.handshake[0].noise_message = flip(copy.handshake[0].noise_message, 40)),
      (copy) => (copy.handshake[1].wire = flip(copy.handshake[1].wire, 50)),
      (copy) => (copy.transport[1]!.ciphertext = flip(copy.transport[1]!.ciphertext, 0)),
      (copy) => (copy.prologue = flip(copy.prologue, 3)),
      (copy) => (copy.psk = flip(copy.psk as string, 0)),
      (copy) => (copy.handshake_hash = flip(copy.handshake_hash, 31)),
      (copy) => (copy.sas = String((Number(copy.sas) + 1) % 1_000_000).padStart(6, "0")),
    ];
    for (const change of cases) {
      const copy = structuredClone(record);
      change(copy);
      expect(replayRecord(copy)).not.toStrictEqual([]);
    }
  });
});

describe("Swift records", () => {
  it("are both here: the ones the Swift side wrote in MP0", () => {
    expect(swiftFiles.toSorted()).toStrictEqual(["swift-ik.json", "swift-ikpsk2.json"]);
  });

  it.each(["swift-ik.json", "swift-ikpsk2.json"])("%s replays byte for byte", (name) => {
    const record = read(name);
    expect(record.format).toBe(1);
    expect(replayRecord(record)).toStrictEqual([]);
  });
});

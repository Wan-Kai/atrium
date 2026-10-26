import { expect, it } from "vitest";
import { nameOf, parseVault } from "./devices";

const device = {
  deviceId: "dev_0123456789abcdef",
  publicKey: "A".repeat(43),
  reportedName: "iPhone",
  name: null,
  model: "iPhone16",
  pairedAt: 1,
};
const contents = { format: 1, hostKey: "A".repeat(43), relay: null, devices: [device] };

it("parses only canonical keys and unique device identities", () => {
  expect(parseVault(JSON.stringify(contents))).toStrictEqual(contents);
  expect(parseVault("garbage")).toBeNull();
  expect(parseVault("{}")).toBeNull();
  expect(parseVault(JSON.stringify({ ...contents, hostKey: "B".repeat(43) }))).toBeNull();
  expect(parseVault(JSON.stringify({ ...contents, devices: [{ ...device, publicKey: "B".repeat(43) }] }))).toBeNull();
  expect(parseVault(JSON.stringify({ ...contents, devices: [device, device] }))).toBeNull();
  expect(
    parseVault(JSON.stringify({ ...contents, devices: [device, { ...device, deviceId: "dev_ffffffffffffffff" }] })),
  ).toBeNull();
});

it("rejects a duplicate device id even when the public keys differ", () => {
  const other = { ...device, publicKey: Buffer.alloc(32, 1).toString("base64url") };
  expect(parseVault(JSON.stringify({ ...contents, devices: [other] }))).toStrictEqual({
    ...contents,
    devices: [other],
  });
  expect(parseVault(JSON.stringify({ ...contents, devices: [device, other] }))).toBeNull();
});

it("bounds decrypted device names, timestamps, format and device count", () => {
  for (const invalid of [
    { ...contents, format: 2 },
    { ...contents, extra: true },
    { ...contents, relay: "r".repeat(513) },
    { ...contents, devices: [{ ...device, extra: true }] },
    { ...contents, devices: [{ ...device, reportedName: "" }] },
    { ...contents, devices: [{ ...device, reportedName: "n".repeat(65) }] },
    { ...contents, devices: [{ ...device, name: "" }] },
    { ...contents, devices: [{ ...device, name: "n".repeat(65) }] },
    { ...contents, devices: [{ ...device, model: "m".repeat(65) }] },
    { ...contents, devices: [{ ...device, pairedAt: -1 }] },
    { ...contents, devices: [{ ...device, pairedAt: 0.5 }] },
  ])
    expect(parseVault(JSON.stringify(invalid))).toBeNull();
  const devices = Array.from({ length: 257 }, (_, i) => ({
    ...device,
    deviceId: `dev_${i.toString(16).padStart(16, "0")}`,
    publicKey: Buffer.concat([Buffer.from([Math.floor(i / 256), i % 256]), Buffer.alloc(30)]).toString("base64url"),
    name: "n".repeat(64),
    model: "m".repeat(64),
    reportedName: "r".repeat(64),
    pairedAt: 0,
  }));
  expect(parseVault(JSON.stringify({ ...contents, devices }))).toBeNull();
  const maximum = { ...contents, devices: devices.slice(0, 256) };
  expect(parseVault(JSON.stringify(maximum))).toStrictEqual(maximum);
});

it("restores the reported name when a local override is cleared", () => {
  expect(nameOf(device)).toBe("iPhone");
  expect(nameOf({ ...device, name: "Mine" })).toBe("Mine");
});

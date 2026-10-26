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

it("restores the reported name when a local override is cleared", () => {
  expect(nameOf(device)).toBe("iPhone");
  expect(nameOf({ ...device, name: "Mine" })).toBe("Mine");
});

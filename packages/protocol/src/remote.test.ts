import { describe, expect, it } from "vitest";
import { RemoteDevice, RemotePairing, RemoteRelay, RemoteRelayDiagnostics } from "./remote";
import { PROTOCOL_VERSION } from "./version";

const diagnostics = {
  kind: "connect",
  checkedAt: 100,
  network: "passed",
  resolution: "not_applicable",
  tls: "not_applicable",
  token: "passed",
  failure: null,
} as const;

const device = {
  deviceId: "dev_0123456789abcdef",
  name: "Phone",
  model: null,
  pairedAt: 100,
  lastSeenAt: null,
  online: false,
  traffic: { down: 0, up: 0 },
};
const relay = {
  url: "ws://127.0.0.1:8787",
  hostId: "hst_0123456789abcdef",
  status: "off",
  error: null,
  lastConnectedAt: null,
  diagnostics: null,
};
const pairing = {
  pairingId: "pair_0123456789abcdef",
  qr: "atrium://pair?v=1",
  expiresAt: 100,
  state: "available",
  handshaking: true,
  reason: null,
  request: null,
  refused: 0,
};

describe("the coordinated remote contract", () => {
  it("uses version 27 rather than either incompatible version 26", () => {
    expect(PROTOCOL_VERSION).toBe(27);
  });

  it.each([
    { schema: RemoteDevice, value: device, field: "model" },
    { schema: RemoteRelay, value: relay, field: "diagnostics" },
    { schema: RemotePairing, value: pairing, field: "handshaking" },
  ])("requires the explicit $field projection", ({ schema, value, field }) => {
    expect(schema.parse(value)).toStrictEqual(value);
    const missing: Record<string, unknown> = { ...value };
    delete missing[field];
    expect(schema.safeParse(missing).success).toBe(false);
  });

  it("keeps unknown, inapplicable and failed evidence distinct", () => {
    expect(RemoteRelayDiagnostics.parse(diagnostics)).toStrictEqual(diagnostics);
    const live = {
      ...diagnostics,
      kind: "live",
      network: "unknown",
      resolution: "unknown",
      tls: "unknown",
      token: "unknown",
      failure: "timeout",
    };
    expect(RemoteRelayDiagnostics.parse(live)).toStrictEqual(live);
    const rejected = { ...diagnostics, token: "failed", failure: "token_rejected" };
    expect(RemoteRelayDiagnostics.parse(rejected)).toStrictEqual(rejected);
  });

  it.each([
    { checkedAt: -1 },
    { network: true },
    { resolution: "offline" },
    { failure: "raw certificate error" },
    { rawError: "never exposed" },
    { kind: "internet" },
  ])("rejects invalid or unsafe diagnostic fields: %j", (fields) => {
    expect(RemoteRelayDiagnostics.safeParse({ ...diagnostics, ...fields }).success).toBe(false);
  });
});

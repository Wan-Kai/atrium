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
  it("uses version 38, which merges the task board (SPEC-0006) with the study loop and inline visuals (SPEC-0008)", () => {
    expect(PROTOCOL_VERSION).toBe(38);
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
    "resolution_failed",
    "tcp_connect_failed",
    "tls_failed",
    "websocket_upgrade_failed",
    "token_rejected",
    "timeout",
    "connection_closed",
    "unknown",
  ])("accepts the fixed diagnostic failure category %s", (failure) => {
    expect(RemoteRelayDiagnostics.parse({ ...diagnostics, failure })).toStrictEqual({ ...diagnostics, failure });
  });

  it("bounds self-reported model text without requiring a fabricated model", () => {
    expect(RemoteDevice.parse({ ...device, model: "x".repeat(64) }).model).toBe("x".repeat(64));
    expect(RemoteDevice.safeParse({ ...device, model: "" }).success).toBe(false);
    expect(RemoteDevice.safeParse({ ...device, model: "x".repeat(65) }).success).toBe(false);
  });

  it.each([
    { checkedAt: -1 },
    { checkedAt: 0.5 },
    { network: true },
    { resolution: "offline" },
    { failure: "raw certificate error" },
    { rawError: "never exposed" },
    { kind: "internet" },
  ])("rejects invalid or unsafe diagnostic fields: %j", (fields) => {
    expect(RemoteRelayDiagnostics.safeParse({ ...diagnostics, ...fields }).success).toBe(false);
  });
});

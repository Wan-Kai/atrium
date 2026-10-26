import { once } from "node:events";
import { request } from "node:http";
import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { RelayDiagnostics } from "./relay-diagnostics";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const unknown = {
  kind: "connect",
  checkedAt: 100,
  network: "unknown",
  resolution: "unknown",
  tls: "unknown",
  token: "unknown",
  failure: "connection_closed",
} as const;

/**
 * Exposes a real ClientRequest's public error boundary without resolving or connecting it.
 * @remarks These are controlled classification inputs, not claims that the OS produced every error code.
 * Real TCP, DNS callback, TLS and upgrade paths remain in relay-diagnostics.test.ts.
 * @sideEffects Allocates a request/socket and registers bounded teardown; never queries external DNS.
 */
async function pendingRequest() {
  const diagnostics = new RelayDiagnostics("wss://unresolved.invalid", new FakeClock(100));
  const req = request("http://unresolved.invalid", { lookup: () => {} });
  req.on("error", () => {});
  cleanup.push(async () => {
    diagnostics.dispose();
    const closed = new Promise<void>((resolve) => req.once("close", () => resolve()));
    req.destroy();
    await closed;
  });
  const assigned = once(req, "socket");
  diagnostics.observe(req);
  await assigned;
  return { diagnostics, req };
}

/** Makes a controlled native-shaped error. @remarks No error text may escape the classifier. @sideEffects none */
function connectionError(code: unknown, syscall: unknown = "connect"): Error {
  return Object.assign(new Error("private error detail"), { code, syscall });
}

describe("initial diagnostic evidence without a network attempt", () => {
  it("does not fabricate address resolution, TLS or upgrade evidence", () => {
    const diagnostics = new RelayDiagnostics("wss://unresolved.invalid", new FakeClock(100));
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual(unknown);
  });

  it("marks literal IPv6 resolution and plain loopback TLS inapplicable, not unknown", () => {
    const diagnostics = new RelayDiagnostics("ws://[::1]:8787", new FakeClock(100));
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({
      ...unknown,
      resolution: "not_applicable",
      tls: "not_applicable",
    });
  });
});

describe("controlled error classification, not platform failure reproduction", () => {
  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_SIGNATURE_FAILURE",
    "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  ])("classifies the native TLS code %s without exposing its text", async (code) => {
    const { diagnostics, req } = await pendingRequest();
    req.emit("error", Object.assign(new Error("private certificate detail"), { code }));
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({ ...unknown, tls: "failed", failure: "tls_failed" });
  });

  it.each(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EACCES", "EPERM"])(
    "classifies pre-connect %s only as connectivity to this relay",
    async (code) => {
      const { diagnostics, req } = await pendingRequest();
      req.emit("error", connectionError(code));
      expect(diagnostics.finish("relay_unreachable")).toStrictEqual({
        ...unknown,
        network: "failed",
        failure: "tcp_connect_failed",
      });
    },
  );

  it.each(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"])("classifies the resolver fallback %s", async (code) => {
    const { diagnostics, req } = await pendingRequest();
    req.emit("error", Object.assign(new Error("private resolver detail"), { code }));
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({
      ...unknown,
      resolution: "failed",
      failure: "resolution_failed",
    });
  });

  it.each([
    { label: "read syscall", error: connectionError("EACCES", "read") },
    { label: "missing syscall", error: connectionError("ECONNREFUSED", null) },
    { label: "unrecognized code", error: connectionError("UNRECOGNIZED") },
    { label: "reset", error: connectionError("ECONNRESET", "read") },
    { label: "generic timeout", error: connectionError("ETIMEDOUT", "read") },
  ])("keeps $label unclassified rather than inventing a failed stage", async ({ error }) => {
    const { diagnostics, req } = await pendingRequest();
    req.emit("error", error);
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({ ...unknown, failure: "unknown" });
  });

  it("retains the first explicit failure across a later error and overall timeout", async () => {
    const { diagnostics, req } = await pendingRequest();
    req.emit("error", Object.assign(new Error("private certificate detail"), { code: "CERT_HAS_EXPIRED" }));
    req.emit("error", connectionError("ECONNREFUSED"));
    diagnostics.timeout();
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({ ...unknown, tls: "failed", failure: "tls_failed" });
  });

  it("classifies an aggregate only when every cause is a recognized connect error", async () => {
    const { diagnostics, req } = await pendingRequest();
    req.emit(
      "error",
      new AggregateError([connectionError("ECONNREFUSED"), connectionError("ENETUNREACH")], "private aggregate"),
    );
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({
      ...unknown,
      network: "failed",
      failure: "tcp_connect_failed",
    });
  });

  it.each([
    { label: "mixed syscall", causes: [connectionError("ECONNREFUSED"), connectionError("EACCES", "read")] },
    { label: "mixed cause", causes: [connectionError("ECONNREFUSED"), new Error("unclassified")] },
    { label: "empty causes", causes: [] },
  ])("does not infer network failure from an aggregate with $label", async ({ causes }) => {
    const { diagnostics, req } = await pendingRequest();
    req.emit("error", new AggregateError(causes, "private aggregate"));
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({ ...unknown, failure: "unknown" });
  });
});

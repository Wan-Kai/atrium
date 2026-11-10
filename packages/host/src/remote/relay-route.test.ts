import { HttpsProxyAgent } from "https-proxy-agent";
import { describe, expect, it } from "vitest";
import { RelayRoute, bypasses, relayProxy } from "./relay-route";

const relay = "wss://relay.example.com/atrium";
const proxy = { url: "http://127.0.0.1:7897", noProxy: [] };

describe("RelayRoute (SPEC-0005, 连 relay 走代理)", () => {
  it("goes through the proxy when one is set, and direct when none is", () => {
    const through = new RelayRoute(() => proxy);
    expect(through.begin(relay)).toBe("proxy");
    expect(through.agent()).toBeInstanceOf(HttpsProxyAgent);
    const direct = new RelayRoute(() => null);
    expect(direct.begin(relay)).toBe("direct");
    expect(direct.agent()).toBeUndefined();
  });

  it("goes direct for a relay whose host is in no-proxy", () => {
    const route = new RelayRoute(() => ({ ...proxy, noProxy: ["localhost", ".example.com"] }));
    expect(route.begin(relay)).toBe("direct");
    expect(route.agent()).toBeUndefined();
  });

  it("goes direct for one attempt after one through the proxy failed, then back to the proxy", () => {
    const route = new RelayRoute(() => proxy);
    expect(route.begin(relay)).toBe("proxy");
    route.failed();
    expect(route.begin(relay)).toBe("direct");
    expect(route.agent()).toBeUndefined();
    expect(route.begin(relay)).toBe("proxy");
  });

  it("does not keep the proxy off after a direct attempt failed", () => {
    const route = new RelayRoute(() => proxy);
    route.begin(relay);
    route.failed();
    route.begin(relay);
    route.failed();
    expect(route.begin(relay)).toBe("proxy");
  });

  it("takes the proxy setting, never sending a relay on this machine through it", () => {
    expect(relayProxy(null)).toBeNull();
    const fromSetting = relayProxy({ url: "http://127.0.0.1:7897", noProxy: ["corp.example"] });
    expect(fromSetting).toStrictEqual({
      url: "http://127.0.0.1:7897",
      noProxy: ["localhost", "127.0.0.1", "::1", "corp.example"],
    });
    const route = new RelayRoute(() => fromSetting);
    expect(route.begin("ws://127.0.0.1:4100")).toBe("direct");
    expect(route.begin("ws://[::1]:4100")).toBe("direct");
    expect(route.begin("wss://ktoon.site/atrium")).toBe("proxy");
  });

  it("matches no-proxy entries by whole host or domain suffix, and * for every host", () => {
    expect(bypasses("relay.example.com", ["example.com"])).toBe(true);
    expect(bypasses("relay.example.com", [".example.com"])).toBe(true);
    expect(bypasses("example.com", [".example.com"])).toBe(true);
    expect(bypasses("badexample.com", ["example.com"])).toBe(false);
    expect(bypasses("[::1]", ["::1"])).toBe(true);
    expect(bypasses("relay.example.com", ["*"])).toBe(true);
    expect(bypasses("relay.example.com", [])).toBe(false);
  });
});

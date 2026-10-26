import { describe, expect, it } from "vitest";
import { clientAddress } from "./client-address";

const trusted = new Set(["127.0.0.1", "10.0.0.2"]);

describe("clientAddress", () => {
  it("uses the connection's address when no proxy is trusted, whatever the headers say", () => {
    expect(
      clientAddress("198.51.100.7", { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2" }, new Set()),
    ).toBe("198.51.100.7");
  });

  it("uses the connection's address when it is not a trusted proxy", () => {
    expect(clientAddress("198.51.100.7", { "x-forwarded-for": "203.0.113.1" }, trusted)).toBe("198.51.100.7");
  });

  it("takes the rightmost untrusted hop of X-Forwarded-For from a trusted proxy", () => {
    const headers = { "x-forwarded-for": "6.6.6.6, 203.0.113.1, 10.0.0.2" };

    expect(clientAddress("127.0.0.1", headers, trusted)).toBe("203.0.113.1");
  });

  it("falls back to X-Real-IP, then to the connection's address", () => {
    expect(clientAddress("127.0.0.1", { "x-real-ip": " 203.0.113.9 " }, trusted)).toBe("203.0.113.9");
    expect(clientAddress("127.0.0.1", { "x-real-ip": "not-an-ip" }, trusted)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", {}, trusted)).toBe("127.0.0.1");
  });

  it("uses the connection's address when the forwarded hop is not an address or every hop is trusted", () => {
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "garbage" }, trusted)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "10.0.0.2, 127.0.0.1" }, trusted)).toBe("127.0.0.1");
  });

  it("prefers X-Forwarded-For over X-Real-IP", () => {
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2" }, trusted)).toBe(
      "203.0.113.1",
    );
  });

  it("writes IPv4-mapped IPv6 as plain IPv4, for the peer and the hops", () => {
    expect(clientAddress("::ffff:127.0.0.1", { "x-forwarded-for": "::ffff:203.0.113.1" }, trusted)).toBe("203.0.113.1");
    expect(clientAddress("::ffff:198.51.100.7", {}, new Set())).toBe("198.51.100.7");
    expect(clientAddress("::ffff:zzz", {}, new Set())).toBe("::ffff:zzz");
    expect(clientAddress("2001:db8::1", {}, new Set())).toBe("2001:db8::1");
  });

  it("gives an empty address when the socket has none", () => {
    expect(clientAddress(undefined, { "x-forwarded-for": "203.0.113.1" }, trusted)).toBe("");
  });
});

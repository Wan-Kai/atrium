import { describe, expect, it } from "vitest";
import { parseRelayLine } from "./relay-line";

const hostId = "hst_0123456789abcdef";
const token = "a".repeat(43);

describe("parseRelayLine", () => {
  it.each([
    ["localhost:8787", "ws"],
    ["127.0.0.1:8787", "ws"],
    ["[::1]:8787", "ws"],
    ["relay.example.com", "wss"],
    ["192.168.1.1:8787", "wss"],
  ])("derives a credential-free endpoint for %s", (host, scheme) => {
    expect(parseRelayLine(`atrium-relay://${hostId}:${token}@${host}/atrium`)).toStrictEqual({
      hostId,
      token,
      url: `${scheme}://${host}/atrium`,
    });
  });

  it.each([
    "https://example.com",
    `atrium-relay://${hostId}:${token}@localhost:99999`,
    `atrium-relay://${hostId}:${token}@localhost/a?token=secret`,
    `atrium-relay://${hostId}:${token}@localhost#fragment`,
    `atrium-relay://${hostId}:short@localhost`,
  ])("rejects invalid relay line %s", (line) => {
    expect(parseRelayLine(line)).toBeNull();
  });
});

import { isIP } from "node:net";

/**
 * The address a connection's request came from, taking forwarded headers only from trusted proxies.
 *
 * @remarks
 * Anyone can send `X-Forwarded-For`, so it is read only when the connection itself comes from an
 * address listed in `relay.json`'s `trustedProxies`; otherwise a phone could pick a fresh address
 * for every connection and walk around the per-IP limit (SPEC-0005, "部署 relay" item 3). The
 * header is read right to left, skipping trusted hops, so a client cannot hide behind addresses
 * it prepends itself. A value that is not an IP address, or a header of trusted hops only, gives
 * the connection's own address. Behind
 * the user's xray fallback every connection comes from 127.0.0.1 and nginx only ever sees that,
 * so there the result is the same for everyone (a known limit).
 *
 * @sideEffects none
 * @param peer - The connection's remote address (`socket.remoteAddress`).
 * @param headers - The upgrade request's headers.
 * @param trusted - Trusted proxy addresses, exact matches.
 * @returns An IP address, IPv4-mapped IPv6 written as plain IPv4.
 */
export function clientAddress(
  peer: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  trusted: ReadonlySet<string>,
): string {
  const direct = plainAddress(peer ?? "");
  if (!trusted.has(direct)) return direct;
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const hops = forwarded.split(",").map((hop) => plainAddress(hop.trim()));
    const client = hops.findLast((hop) => !trusted.has(hop));
    // Stryker disable next-line ConditionalExpression: `isIP(undefined)` is 0 too; the first check is for the type.
    return client !== undefined && isIP(client) !== 0 ? client : direct;
  }
  const real = headers["x-real-ip"];
  if (typeof real === "string" && isIP(plainAddress(real.trim())) !== 0) return plainAddress(real.trim());
  return direct;
}

/**
 * An address with the IPv4-mapped IPv6 prefix taken off.
 *
 * @remarks
 * A dual-stack listener reports IPv4 peers as `::ffff:127.0.0.1`; `trustedProxies` is written in
 * plain IPv4, and one phone should count as one address either way.
 *
 * @sideEffects none
 * @param address - An address as Node or a header gives it.
 * @returns The same address, without the prefix.
 */
function plainAddress(address: string): string {
  // Stryker disable next-line StringLiteral: no other address has an IPv4 address from its eighth character on.
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

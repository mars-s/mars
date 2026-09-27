import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

/**
 * Picks the IPv4 address a phone on the same LAN can actually reach.
 *
 * There is no peer-to-peer discovery in this product, so the desktop has to
 * name itself. Loopback is never a candidate: a phone cannot open it. We
 * prefer a private range, because a phone on the same wifi is the case this
 * feature is actually for, and we skip interfaces that are still down.
 */
export function resolveLanIpv4Address(
  interfaces: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node reports family as the string "IPv4" on every supported version,
      // but older typings still type it as a number, so accept both.
      const isIpv4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (!isIpv4 || entry.internal) continue;
      candidates.push(entry.address);
    }
  }
  const privateFirst = candidates.find(isPrivateIpv4);
  return privateFirst ?? candidates[0] ?? null;
}

function isPrivateIpv4(address: string): boolean {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * A fresh 256-bit pairing token per start. Rotating on every start means a QR
 * that was photographed or shoulder-surfed stops working the moment the
 * operator restarts the session.
 */
export function createPhoneRemoteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The token travels as a query parameter, not a fragment, because the server
 * exchanges it for an HttpOnly cookie and fragments are never sent to a server.
 */
export function buildPhoneRemoteUrl(options: {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly path?: string;
}): string {
  const path = options.path?.trim() || "/";
  const url = new URL(path, `http://${formatHost(options.host)}:${options.port}`);
  url.searchParams.set("token", options.token);
  return url.toString();
}

function formatHost(host: string): string {
  // An IPv6 literal has to be bracketed before it can carry a port.
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

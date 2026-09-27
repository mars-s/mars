import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhoneRemoteUrl,
  createPhoneRemoteToken,
  resolveLanIpv4Address,
} from "../src/host/phoneRemoteNetwork.js";

const iface = (family: "IPv4" | "IPv6", address: string, internal = false) => ({
  family,
  address,
  internal,
  netmask: family === "IPv4" ? "255.255.255.0" : "ffff::",
  mac: "00:00:00:00:00:00",
  cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
});

test("skips loopback and IPv6, and prefers a private address", () => {
  const host = resolveLanIpv4Address({
    lo0: [iface("IPv4", "127.0.0.1", true)],
    en0: [iface("IPv6", "fe80::1"), iface("IPv4", "203.0.113.9")],
    en1: [iface("IPv4", "192.168.1.42")],
  } as never);
  assert.equal(host, "192.168.1.42");
});

test("prefers a tailnet address over the home LAN, so the QR works away from home", () => {
  const host = resolveLanIpv4Address({
    en0: [iface("IPv4", "192.168.1.101")],
    utun100: [iface("IPv4", "100.124.17.182")],
  } as never);
  assert.equal(host, "100.124.17.182");
});

test("does not mistake the rest of 100/8 for a tailnet address", () => {
  const host = resolveLanIpv4Address({
    en0: [iface("IPv4", "100.63.17.182"), iface("IPv4", "192.168.1.101")],
  } as never);
  assert.equal(host, "192.168.1.101");
  assert.equal(
    resolveLanIpv4Address({ en0: [iface("IPv4", "100.128.0.1")] } as never),
    "100.128.0.1",
    "100.128/9 is outside the CGNAT block and should only be a last resort",
  );
});

test("falls back to a routable address when nothing is private", () => {
  const host = resolveLanIpv4Address({
    en0: [iface("IPv4", "203.0.113.9")],
  } as never);
  assert.equal(host, "203.0.113.9");
});

test("returns null when there is no IPv4 at all, so the caller can refuse", () => {
  assert.equal(resolveLanIpv4Address({ lo0: [iface("IPv4", "127.0.0.1", true)] } as never), null);
  assert.equal(resolveLanIpv4Address({} as never), null);
});

test("accepts the numeric family form older Node typings produce", () => {
  const host = resolveLanIpv4Address({
    en0: [{ family: 4, address: "10.0.0.5", internal: false } as never],
  } as never);
  assert.equal(host, "10.0.0.5");
});

test("each token is 256 bits and never repeats", () => {
  const tokens = new Set(Array.from({ length: 64 }, createPhoneRemoteToken));
  assert.equal(tokens.size, 64);
  for (const token of tokens) {
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }
});

test("the URL carries the token as a query parameter, never a fragment", () => {
  const url = new URL(buildPhoneRemoteUrl({ host: "192.168.1.42", port: 7799, token: "tok" }));
  assert.equal(url.origin, "http://192.168.1.42:7799");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("token"), "tok");
  assert.equal(url.hash, "");
});

test("an IPv6 LAN address is bracketed so the port still parses", () => {
  const url = new URL(buildPhoneRemoteUrl({ host: "fd00::1", port: 7799, token: "tok" }));
  assert.equal(url.hostname, "[fd00::1]");
  assert.equal(url.port, "7799");
});

test("a custom path is preserved and still takes the token", () => {
  const url = new URL(
    buildPhoneRemoteUrl({ host: "10.0.0.5", port: 80, token: "tok", path: "/remote" }),
  );
  assert.equal(url.pathname, "/remote");
  assert.equal(url.searchParams.get("token"), "tok");
});

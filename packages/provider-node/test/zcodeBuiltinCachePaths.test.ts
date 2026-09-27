/**
 * The builtin catalog cache is scoped by the control-plane origin, and this fork
 * configures no control plane at all. `resolveZCodeEndpointOrigin` returns "" for
 * that state by design, so an empty origin is the NORMAL case, not an error.
 *
 * It used to throw here, which took down the whole provider view: every
 * `model-selection.getView` failed with "ZCode Built-in Endpoint Origin 不能为空"
 * and the UI showed no providers or models at all.
 *
 * The other half of the contract is isolation. Vendor builds left a real cache
 * directory behind at `endpoint-<sha256("https://zcode.z.ai")>` containing the
 * removed zai-api and bigmodel-api templates. The unconfigured branch must not be
 * able to name that directory, so these tests pin the no-control-plane key to a
 * literal that is provably disjoint from a sha256 suffix.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createZCodeBuiltinEndpointKey,
  normalizeZCodeBuiltinEndpointOrigin,
  resolveZCodeBuiltinCachePaths,
} from "../src/zcode-builtin-cache-paths.js";

const PATHS = {
  environmentConfigRoot: "/tmp/zcode-cache-paths-test",
  platform: "darwin-aarch64",
  appVersion: "3.14.3",
} as const;

test("an unconfigured control plane is a valid state, not an error", () => {
  assert.equal(normalizeZCodeBuiltinEndpointOrigin(""), "");
  assert.equal(normalizeZCodeBuiltinEndpointOrigin("   "), "");
  // It has to survive all the way to a real path, or nothing can read providers.
  const paths = resolveZCodeBuiltinCachePaths({ ...PATHS, zcodeEndpointOrigin: "" });
  assert.ok(
    paths.activeFilePath.startsWith(PATHS.environmentConfigRoot),
    "an unconfigured origin must still produce a usable cache path",
  );
  assert.ok(paths.activeFilePath.endsWith("zcode-builtin.json"));
});

test("a non-empty origin is still validated and normalised", () => {
  assert.equal(
    normalizeZCodeBuiltinEndpointOrigin("https://example.com/v1"),
    "https://example.com",
  );
  assert.equal(
    normalizeZCodeBuiltinEndpointOrigin("http://127.0.0.1:8317/v1"),
    "http://127.0.0.1:8317",
  );
  // These are genuine mistakes and must keep failing loudly.
  assert.throws(() => normalizeZCodeBuiltinEndpointOrigin("ftp://example.com"));
  assert.throws(() => normalizeZCodeBuiltinEndpointOrigin("not-a-url"));
});

test("the no-control-plane key cannot collide with a vendor cache directory", () => {
  const unconfigured = createZCodeBuiltinEndpointKey("");
  // The directory a vendor build actually left on disk.
  const vendor = `endpoint-${createHash("sha256").update("https://zcode.z.ai").digest("hex").slice(0, 32)}`;
  assert.notEqual(unconfigured, vendor);
  assert.equal(vendor.includes(unconfigured), false, "the vendor key must not contain ours");
  // Structurally disjoint: ours is a literal, theirs is 32 hex chars.
  assert.equal(/^endpoint-[0-9a-f]{32}$/.test(unconfigured), false);
  assert.equal(/^endpoint-[0-9a-f]{32}$/.test(vendor), true);
  // And the hash form is still what a real origin produces.
  assert.equal(
    createZCodeBuiltinEndpointKey("https://zcode.z.ai"),
    vendor,
    "a real vendor origin must keep its historical directory, so we never silently move a live cache",
  );
});

test("whitespace-only and unconfigured origins agree, and distinct origins stay distinct", () => {
  assert.equal(createZCodeBuiltinEndpointKey("   "), createZCodeBuiltinEndpointKey(""));
  assert.notEqual(
    createZCodeBuiltinEndpointKey("https://a.example"),
    createZCodeBuiltinEndpointKey("https://b.example"),
  );
  // Same origin through different spellings must land on the same cache.
  assert.equal(
    createZCodeBuiltinEndpointKey("https://a.example/v1"),
    createZCodeBuiltinEndpointKey("https://a.example"),
    "a trailing path must not fork the cache",
  );
});

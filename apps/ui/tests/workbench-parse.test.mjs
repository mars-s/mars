import assert from "node:assert/strict";
import test from "node:test";
import {
  browseTarget,
  parseCapabilities,
  parseChanges,
  parseListing,
  parsePages,
  parseServices,
  parseSuggestions,
  parseTerminalChunk,
} from "../lib/pi/workbench.ts";

test("capabilities default to unavailable with the host's reason", () => {
  const caps = parseCapabilities({ tools: { files: { available: true }, terminal: { available: false, reason: "python3 was not found" } } });
  assert.equal(caps.files.available, true);
  assert.deepEqual(caps.terminal, { available: false, reason: "python3 was not found" });
  assert.equal(caps.browser.available, false);
  assert.match(caps.browser.reason, /does not offer/);
  assert.equal(parseCapabilities(null).changes.available, false);
});

test("listings drop names that try to smuggle a path", () => {
  const listing = parseListing({ path: "a", entries: [{ name: "ok.md", type: "file" }, { name: "../x", type: "file" }, { name: "dir", type: "dir" }] });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["ok.md", "dir"]);
});

test("changes, pages, services and suggestions keep only valid rows", () => {
  assert.equal(parseChanges({ files: [{ path: "a.ts", added: 2 }, { added: 1 }] }).files.length, 1);
  assert.deepEqual(parsePages({ pages: [{ name: "plan" }, { name: "../etc" }] }).map((page) => page.name), ["plan"]);
  assert.deepEqual(parseServices({ services: [{ port: 3100 }, { port: 99999 }, { port: "x" }] }).map((s) => s.port), [3100]);
  const suggestions = parseSuggestions({
    suggestions: [
      { kind: "service", port: 3100, title: "Chemwatch" },
      { kind: "extension", hash: "b".repeat(64), title: "Canvas" },
      { kind: "extension", hash: "nope" },
      { kind: "page", name: "plan" },
      { kind: "telemetry" },
    ],
  });
  assert.deepEqual(suggestions.map((item) => item.kind), ["service", "extension", "page"]);
});

test("terminal chunks keep offsets and exit state", () => {
  assert.deepEqual(parseTerminalChunk({ offset: 42, data: "aGk=", exited: true, exitCode: 0 }), { offset: 42, data: "aGk=", exited: true, exitCode: 0, dropped: false });
});

test("browser targets: local ports are proxied, anything else is external", () => {
  assert.deepEqual(browseTarget("localhost:3100/docs?x=1"), { kind: "local", port: 3100, path: "/docs?x=1" });
  assert.deepEqual(browseTarget(":5173"), { kind: "local", port: 5173, path: "/" });
  assert.deepEqual(browseTarget("http://127.0.0.1:8080"), { kind: "local", port: 8080, path: "/" });
  assert.deepEqual(browseTarget("https://kokonutui.com/docs"), { kind: "external", url: "https://kokonutui.com/docs" });
  assert.equal(browseTarget("https://localhost:3100").kind, "external", "https loopback is not proxied");
  assert.equal(browseTarget("javascript:alert(1)").kind, "invalid");
  assert.equal(browseTarget("").kind, "invalid");
});

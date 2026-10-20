import assert from "node:assert/strict";
import test from "node:test";
import { parseFile, parseListing, parseSearch } from "../lib/pi/workbench.ts";
import { ancestors, flattenTree, formatSize, lineGutter, resolveRelative } from "../components/workbench/files-model.ts";

test("listing keeps link targets inside the workspace and marks dotfiles", () => {
  const listing = parseListing({
    path: "notes",
    truncated: true,
    entries: [
      { name: ".env", type: "file", size: 4 },
      { name: "in", type: "link", target: { type: "dir", path: "docs" } },
      { name: "out", type: "link", target: { type: "dir", path: "/etc" } },
      { name: "up", type: "link", target: { type: "file", path: "../secret" } },
      { name: "..", type: "dir" },
    ],
  });
  assert.equal(listing.truncated, true);
  assert.deepEqual(listing.entries.map((entry) => entry.name), [".env", "in", "out", "up"]);
  assert.equal(listing.entries[0].hidden, true);
  assert.deepEqual(listing.entries[1].target, { type: "dir", path: "docs" });
  assert.deepEqual(listing.entries[2].target, { type: "outside" }, "an absolute link target is never opened");
  assert.deepEqual(listing.entries[3].target, { type: "outside" }, "a climbing link target is never opened");
  assert.equal(parseListing({ path: "../x" }).path, "");
});

test("file content only carries text for text and a known image type for images", () => {
  assert.deepEqual(parseFile({ path: "a.png", kind: "image", mime: "image/png", text: "x", truncated: true }), {
    path: "a.png",
    size: 0,
    modified: 0,
    kind: "image",
    text: "",
    truncated: false,
    mime: "image/png",
  });
  assert.equal(parseFile({ kind: "image", mime: "text/html" }).mime, "", "an unexpected type is dropped");
  assert.equal(parseFile({ kind: "binary", text: "leak" }).text, "");
  const text = parseFile({ path: "a.md", kind: "text", text: "# A", truncated: true, size: 3 });
  assert.deepEqual([text.kind, text.text, text.truncated], ["text", "# A", true]);
  assert.equal(parseFile({ kind: "weird" }).kind, "text");
});

test("search keeps valid relative hits and the host's limit flags", () => {
  const result = parseSearch({ results: [{ path: "a/b.md" }, { path: "/etc/passwd" }, { path: "../x" }, { path: "d", type: "dir" }, {}], truncated: true, timedOut: true });
  assert.deepEqual(result.results, [
    { path: "a/b.md", type: "file" },
    { path: "d", type: "dir" },
  ]);
  assert.deepEqual([result.truncated, result.timedOut], [true, true]);
  assert.deepEqual(parseSearch(null), { results: [], truncated: false, timedOut: false });
});

test("ancestors list every folder that must be open, root first", () => {
  assert.deepEqual(ancestors("a/b/c.md"), ["", "a", "a/b"]);
  assert.deepEqual(ancestors("top.md"), [""]);
});

const ready = (entries, truncated = false) => ({ status: "ready", listing: { path: "", truncated, entries } });
const entry = (name, type = "file") => ({ name, type, size: 0, modified: 0, hidden: false });

test("the flattened tree shows children only of expanded folders, with depth", () => {
  const dirs = {
    "": ready([entry("docs", "dir"), entry("src", "dir"), entry("README.md")]),
    docs: ready([entry("guide.md")]),
    src: ready([entry("index.ts")]),
  };
  const rows = flattenTree(dirs, new Set(["docs"]));
  assert.deepEqual(
    rows.map((row) => (row.kind === "entry" ? `${row.depth}:${row.path}${row.expanded ? "/" : ""}` : `note:${row.text}`)),
    ["1:docs/", "2:docs/guide.md", "1:src", "1:README.md"],
  );
});

test("loading, error, empty and truncated folders become notes", () => {
  const rows = flattenTree(
    { "": ready([entry("a", "dir"), entry("b", "dir"), entry("c", "dir")], true), a: { status: "loading" }, b: { status: "error", error: "No access" }, c: ready([]) },
    new Set(["a", "b", "c"]),
  );
  const notes = rows.filter((row) => row.kind === "note");
  assert.deepEqual(notes.map((row) => row.text), ["Loading…", "No access", "Empty folder", "Showing the first 3 items."]);
  assert.equal(notes[1].retry, "b");
});

test("Markdown links resolve inside the workspace or not at all", () => {
  assert.equal(resolveRelative("docs/guide.md", "./img/a.png"), "docs/img/a.png");
  assert.equal(resolveRelative("docs/guide.md", "../README.md#top"), "README.md");
  assert.equal(resolveRelative("docs/guide.md", "/notes/x%20y.md"), "notes/x y.md");
  assert.equal(resolveRelative("docs/guide.md", "../../etc/passwd"), null);
  assert.equal(resolveRelative("guide.md", "https://example.com/a.png"), null);
  assert.equal(resolveRelative("guide.md", "//cdn.example.com/a.png"), null);
  assert.equal(resolveRelative("guide.md", "mailto:me@example.com"), null);
  assert.equal(resolveRelative("guide.md", "#section"), null);
});

test("sizes and line numbers read naturally", () => {
  assert.equal(formatSize(1), "1 byte");
  assert.equal(formatSize(900), "900 bytes");
  assert.equal(formatSize(48 * 1024), "48 KB");
  assert.equal(formatSize(3.25 * 1024 * 1024), "3.3 MB");
  assert.equal(lineGutter("a\nb\n"), "1\n2", "a trailing newline does not add a line");
  assert.equal(lineGutter("a\nb"), "1\n2");
  assert.equal(lineGutter(""), "1");
});

import assert from "node:assert/strict";
import test from "node:test";
import { pageTitle, parsePage, parsePages, parseSavedPage } from "../lib/pi/workbench.ts";

test("page title is the first level-one heading, else the name", () => {
  assert.equal(pageTitle("intro\n# Release plan ##\n# Later", "x"), "Release plan");
  assert.equal(pageTitle("## Not a title\ntext", "notes"), "notes");
  assert.equal(pageTitle("#No space", "notes"), "notes");
  assert.equal(pageTitle("", "untitled"), "untitled");
});

test("page summaries need a valid name and default the title", () => {
  const pages = parsePages({ pages: [{ name: "plan", modified: 5 }, { name: "Bad Name" }, { name: "../x" }, "junk"] });
  assert.deepEqual(pages, [{ name: "plan", title: "plan", modified: 5, size: 0 }]);
});

test("a page read keeps text and modified time", () => {
  assert.deepEqual(parsePage({ name: "plan", text: "# Plan", modified: 12 }), { name: "plan", text: "# Plan", modified: 12 });
  assert.deepEqual(parsePage(null), { name: "", text: "", modified: 0 });
});

test("a save is confirmed only with a valid name and modified time", () => {
  assert.deepEqual(parseSavedPage({ name: "plan", title: "Plan", modified: 9, size: 6 }), { name: "plan", title: "Plan", modified: 9, size: 6 });
  assert.throws(() => parseSavedPage({ name: "plan" }), /did not confirm/);
  assert.throws(() => parseSavedPage({ name: "../plan", modified: 9 }), /did not confirm/);
  assert.throws(() => parseSavedPage({ error: "This page changed elsewhere", modified: 9 }), /did not confirm/);
});

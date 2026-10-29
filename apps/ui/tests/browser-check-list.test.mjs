// npm run test:browser runs only the browser checks named in the "test:ui" script
// (scripts/browser-checks.mjs reads that list). A check left out of it never runs, so every
// tests/*-ui-check.mjs must be named there, and every name there must be a file.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// The same reading as scripts/browser-checks.mjs.
const listed = new Set(pkg.scripts["test:ui"].match(/tests\/[\w-]+\.mjs/g));
// Checks run on their own rather than in the browser suite, each with where it is documented.
// Duet is parked (docs/DUET.md "Parked"): its checks run by hand when it is turned back on.
const RUN_SEPARATELY = new Map([
  ["tests/duet-ui-check.mjs", "docs/DUET.md"],
  ["tests/duet-apart-ui-check.mjs", "docs/DUET.md"],
  ["tests/duet-quiet-confirm-ui-check.mjs", "docs/DUET.md"],
]);

test("every browser check is in the test:ui list", async () => {
  const files = (await readdir(new URL(".", import.meta.url))).filter((name) => name.endsWith("-ui-check.mjs"));
  assert.ok(files.length > 10);
  const missing = files.map((name) => `tests/${name}`).filter((path) => !listed.has(path) && !RUN_SEPARATELY.has(path));
  assert.deepEqual(missing, [], "add these to the test:ui script in apps/ui/package.json");
});

test("every check named in test:ui exists", async () => {
  const files = new Set((await readdir(new URL(".", import.meta.url))).map((name) => `tests/${name}`));
  assert.deepEqual([...listed].filter((path) => !files.has(path)), []);
});

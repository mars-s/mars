import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "./workbench/test-host.mjs";

const host = await startHost();
const outside = await mkdtemp(join(tmpdir(), "mars-pages-outside-"));
// The host's body reader stops at 2 MiB and may reset the socket mid-upload, so this
// request settles on the status line and swallows the reset on either stream.
const oversized = (bytes) =>
  new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: host.port, path: "/api/workbench/pages", method: "POST", headers: { host: `127.0.0.1:${host.port}`, authorization: "Bearer " + host.token, origin: `http://127.0.0.1:${host.port}`, "content-type": "application/json", connection: "close" } },
      (res) => {
        res.on("error", () => undefined);
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", (error) => resolve(error.code));
    req.end(JSON.stringify({ name: "huge", text: "a".repeat(bytes) }));
  });
try {
  const pages = join(host.work, "pages");
  assert.equal((await host.request("/api/workbench/pages", { auth: false })).status, 401, "list needs owner auth");
  assert.equal((await host.request("/api/workbench/pages/plan", { auth: false })).status, 401, "read needs owner auth");
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: { text: "x" }, auth: false })).status, 401, "save needs owner auth");
  assert.equal(
    (await host.request("/api/workbench/pages", { method: "POST", body: { text: "x" }, headers: { origin: "https://evil.test" } })).status,
    403,
    "cross-origin save is rejected",
  );

  assert.deepEqual((await host.request("/api/workbench/pages")).json, { pages: [] }, "no pages folder lists empty");

  const first = await host.request("/api/workbench/pages", { method: "POST", body: { text: "" } });
  assert.equal(first.status, 201, "create without a name");
  assert.equal(first.json.name, "untitled");
  const second = await host.request("/api/workbench/pages", { method: "POST", body: { text: "# Second\n" } });
  assert.equal(second.json.name, "untitled-2", "generated names never collide");
  assert.equal(second.json.title, "Second");

  const created = await host.request("/api/workbench/pages", { method: "POST", body: { name: "release-plan", text: "# Release plan\n\nShip it." } });
  assert.equal(created.status, 201);
  assert.equal(created.json.title, "Release plan", "title is the first heading");
  const read = await host.request("/api/workbench/pages/release-plan");
  assert.equal(read.status, 200);
  assert.equal(read.json.text, "# Release plan\n\nShip it.");
  assert.equal(read.json.modified, created.json.modified, "read reports the saved modified time");

  const update = await host.request("/api/workbench/pages", { method: "POST", body: { name: "release-plan", text: "# Release plan\n\nShip it today.", baseModified: read.json.modified } });
  assert.equal(update.status, 200, "save with the current baseModified");
  assert.ok(update.json.modified !== read.json.modified, "modified moves on save");

  const stale = await host.request("/api/workbench/pages", { method: "POST", body: { name: "release-plan", text: "# Old copy", baseModified: read.json.modified } });
  assert.equal(stale.status, 409, "stale baseModified is rejected");
  assert.equal(stale.json.modified, update.json.modified, "409 carries the newer modified time");
  assert.equal((await readFile(join(pages, "release-plan.md"), "utf8")), "# Release plan\n\nShip it today.", "stale save left the newer text alone");
  const recreate = await host.request("/api/workbench/pages", { method: "POST", body: { name: "release-plan", text: "# Blind" } });
  assert.equal(recreate.status, 409, "saving over an existing page without baseModified is rejected");
  const overwrite = await host.request("/api/workbench/pages", { method: "POST", body: { name: "release-plan", text: "# Overwritten", baseModified: stale.json.modified } });
  assert.equal(overwrite.status, 200, "explicit overwrite with the newer modified time succeeds");
  const gone = await host.request("/api/workbench/pages", { method: "POST", body: { name: "never-was", text: "x", baseModified: 1 } });
  assert.equal(gone.status, 409, "a baseModified for a missing page is a conflict, not a silent create");

  const listing = await host.request("/api/workbench/pages");
  assert.deepEqual(listing.json.pages.map((page) => page.name), ["release-plan", "untitled-2", "untitled"], "newest first");
  assert.equal(listing.json.pages[0].title, "Overwritten");
  assert.equal(listing.json.pages[2].title, "untitled", "title falls back to the name");
  assert.deepEqual((await readdir(pages)).filter((name) => name.endsWith(".tmp")), [], "atomic writes leave no temp files");

  for (const bad of ["../escape", "Upper", "a/b", "a.md", "x".repeat(65), "", "%2e%2e"]) {
    const save = await host.request("/api/workbench/pages", { method: "POST", body: { name: bad, text: "x" } });
    assert.equal(save.status, 400, `rejects name ${JSON.stringify(bad)} on save`);
  }
  for (const bad of ["..%2Fsecret", "%2e%2e", "Upper", "a.md"]) assert.ok([400, 403, 404].includes((await host.request(`/api/workbench/pages/${bad}`)).status), `rejects read of ${bad}`);
  assert.equal((await host.request("/api/workbench/pages/../../data/web-token")).status, 404, "dot segments never reach the page reader");
  assert.equal((await host.request("/api/workbench/pages/missing")).status, 404);

  await writeFile(join(outside, "secret.md"), "# Secret");
  await symlink(join(outside, "secret.md"), join(pages, "leak.md"));
  assert.equal((await host.request("/api/workbench/pages/leak")).status, 403, "symlinked page outside the workspace is refused");
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: { name: "leak", text: "x" } })).status, 403, "cannot write through an escaping symlink");
  assert.equal(await readFile(join(outside, "secret.md"), "utf8"), "# Secret");
  assert.ok(!(await host.request("/api/workbench/pages")).json.pages.some((page) => page.name === "leak"), "symlinks are not listed");

  const big = "a".repeat(1024 * 1024 + 1);
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: { name: "big", text: big }, headers: { connection: "close" } })).status, 413, "text over 1 MiB is rejected");
  const huge = await oversized(3 * 1024 * 1024);
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(huge), `bodies over the host cap are refused (${huge})`);
  assert.equal((await host.request("/api/workbench/pages/huge")).status, 404, "nothing was written for the refused body");
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: { name: "exact", text: "a".repeat(1024 * 1024) }, headers: { connection: "close" } })).status, 201, "exactly 1 MiB is accepted");
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: { name: "num", text: 5 } })).status, 400, "text must be a string");
  assert.equal((await host.request("/api/workbench/pages", { method: "POST", body: "not json" })).status, 400, "malformed JSON is a 400");

  const racers = await Promise.all(Array.from({ length: 6 }, (_, n) => host.request("/api/workbench/pages", { method: "POST", body: { name: "race", text: `# ${n}` } })));
  assert.deepEqual(racers.map((res) => res.status).sort(), [201, 409, 409, 409, 409, 409], "concurrent creates of one name: exactly one wins");
  const base = (await host.request("/api/workbench/pages/race")).json.modified;
  const edits = await Promise.all(Array.from({ length: 4 }, (_, n) => host.request("/api/workbench/pages", { method: "POST", body: { name: "race", text: `edit ${n}`, baseModified: base } })));
  assert.deepEqual(edits.map((res) => res.status).sort(), [200, 409, 409, 409], "concurrent saves from one base: exactly one wins");

  const suggestions = await host.request("/api/workbench/suggestions");
  const pageRows = suggestions.json.suggestions.filter((row) => row.kind === "page");
  assert.equal(pageRows.length, 5, "suggestions carry the five most recent pages");
  assert.equal(pageRows[0].name, "race");
  const caps = await host.request("/api/workbench/capabilities");
  assert.equal(caps.json.tools.page.available, true, "page capability is on");

} finally {
  await host.stop();
}

const linked = await startHost();
try {
  await mkdir(linked.work, { recursive: true });
  await symlink(outside, join(linked.work, "pages"));
  assert.equal((await linked.request("/api/workbench/pages")).status, 403, "a pages folder that links outside the workspace is refused");
  assert.equal((await linked.request("/api/workbench/pages", { method: "POST", body: { name: "x", text: "x" } })).status, 403);
  assert.deepEqual((await readdir(outside)).sort(), ["secret.md"], "nothing was written outside");
} finally {
  await linked.stop();
}
console.log(
  "PASS workbench pages: owner auth and origin, generated names, title from heading, newest first, stale baseModified 409 incl. missing page, explicit overwrite, atomic writes, name rules, symlink escape on read, write and folder, 1 MiB cap, concurrent create and save, suggestions",
);

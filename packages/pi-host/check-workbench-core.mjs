import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInside } from "./workbench/paths.mjs";
import { startHost } from "./workbench/test-host.mjs";

// Path confinement, independent of any route.
const root = await mkdtemp(join(tmpdir(), "mars-paths-"));
const outside = await mkdtemp(join(tmpdir(), "mars-outside-"));
await mkdir(join(root, "notes"));
await writeFile(join(root, "notes/a.md"), "a");
await symlink(outside, join(root, "escape"));
await symlink(join(root, "notes"), join(root, "inside-link"));
assert.equal((await resolveInside(root, "notes/a.md")).relative, "notes/a.md");
assert.equal((await resolveInside(root, "")).relative, "");
assert.equal((await resolveInside(root, "inside-link/a.md")).relative, "notes/a.md", "symlink inside the root is followed");
assert.equal((await resolveInside(root, "notes/new/deeper.md")).relative, "notes/new/deeper.md", "missing paths resolve via their existing ancestor");
for (const bad of ["../x", "notes/../../x", "/etc/passwd", "escape", "escape/secret.txt", "a\0b"])
  await assert.rejects(resolveInside(root, bad), (error) => error.status === 403 || error.status === 400, `rejects ${JSON.stringify(bad)}`);

const host = await startHost();
try {
  assert.equal((await host.request("/api/workbench/capabilities", { auth: false })).status, 401, "owner auth required");
  const caps = await host.request("/api/workbench/capabilities");
  assert.equal(caps.status, 200);
  for (const tool of ["changes", "files", "terminal", "side-chat", "page", "browser"]) {
    const cap = caps.json.tools[tool];
    assert.ok(cap && (cap.available === true || (cap.available === false && cap.reason.length > 0)), `${tool} is either available or carries a reason`);
  }
  assert.equal(caps.json.tools["side-chat"].available, true, "side chat uses existing conversation routes");
  const suggestions = await host.request("/api/workbench/suggestions");
  assert.equal(suggestions.status, 200);
  assert.ok(Array.isArray(suggestions.json.suggestions));
  assert.equal((await host.request("/api/workbench/nope")).status, 404);
  assert.equal(
    (await host.request("/api/workbench/capabilities", { method: "POST", body: {}, headers: { origin: "https://evil.test" } })).status,
    403,
    "cross-origin writes are rejected before workbench routes",
  );
} finally {
  await host.stop();
}
console.log("PASS workbench core: path confinement incl. symlink escape, owner auth, honest capabilities, origin check");

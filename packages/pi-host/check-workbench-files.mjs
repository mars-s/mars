import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LIMITS, createFiles, searchFiles, sniffImage } from "./workbench/files.mjs";
import { startHost } from "./workbench/test-host.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
assert.equal(sniffImage(PNG), "image/png");
assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
assert.equal(sniffImage(Buffer.from("GIF89a")), "image/gif");
assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), "", "SVG is never served as an image");

// The time budget holds on a tree too large to finish.
const wide = await mkdtemp(join(tmpdir(), "mars-search-"));
for (let n = 0; n < 40; n++) {
  await mkdir(join(wide, `d${n}`));
  await Promise.all(Array.from({ length: 50 }, (_, m) => writeFile(join(wide, `d${n}`, `f${m}.txt`), "")));
}
const started = Date.now();
const slow = await searchFiles(wide, "zzz-no-match", { budgetMs: 1 });
assert.ok(slow.timedOut && Date.now() - started < 1000, "search stops at its time budget");

const host = await startHost();
const outside = await mkdtemp(join(tmpdir(), "mars-files-outside-"));
try {
  const { work, request } = host;
  await writeFile(join(outside, "secret.txt"), "outside the workspace");
  await mkdir(join(work, "notes/deep"), { recursive: true });
  await writeFile(join(work, "notes/plan.md"), "# Plan\n\nShip the files pane.\n");
  await writeFile(join(work, "notes/deep/plan-old.md"), "old");
  await writeFile(join(work, ".env.example"), "KEY=");
  await writeFile(join(work, "pixel.png"), PNG);
  await writeFile(join(work, "fake.png"), "not really an image");
  await writeFile(join(work, "image.txt"), PNG);
  await writeFile(join(work, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]));
  await writeFile(join(work, "big.txt"), "a".repeat(FILE_LIMITS.text + 4096));
  await mkdir(join(work, "node_modules/plan-pkg"), { recursive: true });
  await writeFile(join(work, "node_modules/plan-pkg/plan.js"), "");
  await mkdir(join(work, ".git"), { recursive: true });
  await writeFile(join(work, ".git/plan"), "");
  await symlink(outside, join(work, "escape"));
  await symlink(join(outside, "secret.txt"), join(work, "secret-link.txt"));
  await symlink(join(work, "notes"), join(work, "notes-link"));

  for (const route of ["files", "file?path=notes/plan.md", "raw?path=pixel.png", "search?q=plan"])
    assert.equal((await request(`/api/workbench/${route}`, { auth: false })).status, 401, `${route} needs owner auth`);

  for (const bad of ["../", "notes/../../etc", "/etc/passwd", "escape", "escape/secret.txt", "secret-link.txt"])
    for (const route of ["files", "file", "raw"]) {
      const response = await request(`/api/workbench/${route}?path=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 403, `${route} rejects ${bad}`);
      assert.ok(!response.text.includes("outside the workspace") && !response.text.includes(outside), "no outside content or host path leaks");
    }

  const root = await request("/api/workbench/files");
  assert.equal(root.status, 200);
  assert.equal(root.json.path, "");
  assert.equal(root.json.truncated, false);
  const names = root.json.entries.map((entry) => entry.name);
  assert.ok(names.indexOf("notes") < names.indexOf("big.txt"), "folders sort first");
  const byName = Object.fromEntries(root.json.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName[".env.example"].hidden, true, "dotfiles are listed and marked");
  assert.equal(byName["node_modules"].type, "dir", "node_modules is listed");
  assert.equal(byName["pixel.png"].size, PNG.length);
  assert.equal(byName.escape.type, "link");
  assert.equal(byName.escape.target.type, "outside", "a link out of the workspace is marked, never resolved");
  assert.deepEqual(byName["notes-link"].target, { type: "dir", path: "notes" });
  const sub = await request("/api/workbench/files?path=notes-link");
  assert.equal(sub.json.path, "notes", "an inside link lists its real folder");
  assert.equal((await request("/api/workbench/files?path=missing")).status, 404);
  assert.equal((await request("/api/workbench/files?path=notes/plan.md")).status, 400, "a file is not a folder");

  const text = await request("/api/workbench/file?path=notes/plan.md");
  assert.equal(text.status, 200);
  assert.deepEqual({ kind: text.json.kind, text: text.json.text, truncated: text.json.truncated }, { kind: "text", text: "# Plan\n\nShip the files pane.\n", truncated: false });
  const big = await request("/api/workbench/file?path=big.txt");
  assert.equal(big.json.size, FILE_LIMITS.text + 4096);
  assert.equal(big.json.text.length, FILE_LIMITS.text, "text is capped at 2 MiB");
  assert.equal(big.json.truncated, true);
  assert.equal((await request("/api/workbench/file?path=notes")).status, 400, "a folder is not a file");

  const image = await request("/api/workbench/file?path=image.txt");
  assert.deepEqual([image.json.kind, image.json.mime, image.json.text], ["image", "image/png", undefined], "image detected from bytes despite .txt");
  const fake = await request("/api/workbench/file?path=fake.png");
  assert.equal(fake.json.kind, "text", "a .png with text bytes is text");
  const binary = await request("/api/workbench/file?path=blob.bin");
  assert.deepEqual([binary.json.kind, binary.json.size, binary.json.text], ["binary", 8, undefined]);

  const raw = await request("/api/workbench/raw?path=pixel.png", { raw: true });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers["content-type"], "image/png");
  assert.equal(raw.headers["x-content-type-options"], "nosniff");
  assert.ok(raw.buffer.equals(PNG), "raw streams the exact bytes");
  assert.equal((await request("/api/workbench/raw?path=image.txt", { raw: true })).headers["content-type"], "image/png");
  assert.equal((await request("/api/workbench/raw?path=fake.png")).status, 415, "raw refuses non-images named .png");
  assert.equal((await request("/api/workbench/raw?path=blob.bin")).status, 415);

  const search = await request("/api/workbench/search?q=plan");
  assert.equal(search.status, 200);
  const paths = search.json.results.map((hit) => hit.path);
  assert.ok(paths.includes("notes/plan.md") && paths.includes("notes/deep/plan-old.md"));
  assert.ok(paths.indexOf("notes/plan.md") < paths.indexOf("notes/deep/plan-old.md"), "exact names rank first");
  assert.ok(!paths.some((path) => path.startsWith("node_modules/") || path.startsWith(".git/")), "search skips node_modules and .git");
  assert.ok(!paths.some((path) => path.startsWith("notes-link/") || path.startsWith("escape/")), "search does not follow links");
  assert.deepEqual((await request("/api/workbench/search?q=")).json.results, []);

  await mkdir(join(work, "many"));
  await Promise.all(Array.from({ length: FILE_LIMITS.entries + 50 }, (_, n) => writeFile(join(work, "many", `match-${n}.txt`), "")));
  const capped = await request("/api/workbench/files?path=many");
  assert.equal(capped.json.entries.length, FILE_LIMITS.entries, "listings cap at 2,000 entries");
  assert.equal(capped.json.truncated, true);
  const many = await request("/api/workbench/search?q=match-");
  assert.equal(many.json.results.length, FILE_LIMITS.results, "search caps at 200 results");
  assert.equal(many.json.truncated, true);

  assert.equal((await request("/api/workbench/file?path=pixel.png", { method: "POST", body: {} })).status, 404, "files are read-only");

  // Downloads: any regular file, as an inert attachment, with the same confinement.
  await writeFile(join(work, "notes/report \"final\" é.html"), "<script>parent.x=1</script>");
  const html = await request(`/api/workbench/download?path=${encodeURIComponent('notes/report "final" é.html')}`, { raw: true });
  assert.equal(html.status, 200);
  assert.equal(html.buffer.toString(), "<script>parent.x=1</script>", "bytes are unchanged");
  assert.equal(html.headers["content-type"], "application/octet-stream", "never served as HTML");
  assert.equal(html.headers["x-content-type-options"], "nosniff");
  assert.match(html.headers["content-security-policy"], /sandbox/);
  assert.equal(html.headers["content-disposition"], `attachment; filename="report _final_ _.html"; filename*=UTF-8''${encodeURIComponent('report "final" é.html')}`);
  const blob = await request("/api/workbench/download?path=blob.bin", { raw: true });
  assert.deepEqual([...blob.buffer], [0, 1, 2, 3, 255, 254, 0, 9], "binary files download intact");
  assert.equal((await request("/api/workbench/download?path=blob.bin", { auth: false })).status, 401, "downloads need the owner");
  for (const bad of ["../secret.txt", "/etc/hosts", "escape/secret.txt"])
    assert.equal((await request(`/api/workbench/download?path=${encodeURIComponent(bad)}`)).status, 403, `download of ${bad} is refused`);
  assert.equal((await request("/api/workbench/download?path=notes")).status, 400, "folders are not downloads");
  await writeFile(join(work, "huge.bin"), Buffer.alloc(FILE_LIMITS.raw + 1));
  assert.equal((await request("/api/workbench/download?path=huge.bin")).status, 413, "downloads stop at 20 MiB");
  // The agent's workspace_file_link uses link(): same checks, a URL, never contents.
  const files = createFiles({ work });
  const linked = await files.link("notes/plan.md");
  assert.deepEqual(linked, { path: "notes/plan.md", size: Buffer.byteLength("# Plan\n\nShip the files pane.\n"), url: "/api/workbench/download?path=notes%2Fplan.md" });
  assert.equal((await request(linked.url, { raw: true })).buffer.toString(), "# Plan\n\nShip the files pane.\n", "the link downloads the file");
  for (const bad of ["../secret.txt", "escape/secret.txt", "notes", "huge.bin"]) await assert.rejects(files.link(bad), `link refuses ${bad}`);
} finally {
  await host.stop();
}
console.log(
  "downloads (inert attachment, owner only, confined, 20 MiB) and " +
  "PASS workbench files: owner auth, ../ absolute and symlink escape 403, listing with dotfiles and links, folders first, text, 2 MiB cap, sniffed images and raw, binary, 2,000-entry cap, search ranking, skips and 200 cap, 3 s budget, read-only",
);

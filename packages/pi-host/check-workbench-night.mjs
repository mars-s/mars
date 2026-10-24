// Workbench night fixes (docs/WORKBENCH.md): a browse key stops when its port's owner
// can no longer be seen, a dev server slow on its first page is not hidden for five
// minutes, one broken Suggestions source does not empty the list, and Changes errors
// never carry an absolute host path.
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser } from "./workbench/browser.mjs";
import { createChanges } from "./workbench/changes.mjs";
import { createWorkbench } from "./workbench/index.mjs";
import { createPages } from "./workbench/pages.mjs";

const scratch = await mkdtemp(join(tmpdir(), "mars-workbench-night-"));
const realNow = Date.now;
const later = (ms) => (Date.now = () => realNow() + ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
};

// A fake `ss` the browser module lists through, so pids can be shown or hidden at will.
const bin = join(scratch, "bin");
await mkdir(bin);
const listing = join(scratch, "listing");
await writeFile(join(bin, "ss"), `#!/bin/sh\ncat '${listing}'\n`);
await chmod(join(bin, "ss"), 0o755);
const row = (port, pid) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*${pid ? ` users:(("node",pid=${pid},fd=20))` : ""}\n`;
const fakeBrowser = () => createBrowser({ hostPort: 1, uiPort: 2, env: {}, platform: "linux", listerDirs: [bin] });
async function mint(browser, port) {
  let reply;
  const send = (res, status, value) => (reply = { status, value });
  await browser.handle({ method: "POST", headers: {} }, {}, new URL("http://l/api/workbench/browse-key"), "browse-key", { send, jsonBody: async () => ({ port }) });
  return reply;
}

try {
  // 1. A key minted for pid 111 stops working when another process takes the port and
  // ss cannot show its pid (another user's service). Unknown is not the same owner.
  {
    const named = (name) => http.createServer((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(`service ${name}`));
    const first = named("A");
    const port = await listen(first);
    await writeFile(listing, row(port, 111));
    const browser = fakeBrowser();
    const minted = await mint(browser, port);
    assert.equal(minted.status, 201, "a key is minted for the discovered service");
    const front = http.createServer(async (req, res) => {
      if (!(await browser.handleKeyed(req, res, new URL(req.url, "http://l"), { send: json }))) json(res, 401, { error: "Sign in" });
    });
    const frontPort = await listen(front);
    const get = async () => {
      const reply = await fetch(`http://127.0.0.1:${frontPort}/api/workbench/browse/${port}/~${minted.value.key}/`);
      return { status: reply.status, text: await reply.text() };
    };
    try {
      assert.deepEqual(await get(), { status: 200, text: "service A" }, "the key reaches the service it was minted for");
      later(11_000);
      assert.deepEqual(await get(), { status: 200, text: "service A" }, "a fresh discovery that still shows pid 111 keeps the key working");
      await close(first);
      const second = named("B");
      await listen(second, port);
      await writeFile(listing, row(port, null));
      later(22_000);
      try {
        const after = await get();
        assert.equal(after.status, 401, `a key does not reach a newcomer whose pid ss hides (got ${after.status} ${after.text})`);
        assert.ok(!after.text.includes("service B"), "nothing from the new service is forwarded");
      } finally {
        await close(second);
      }
    } finally {
      Date.now = realNow;
      await close(front);
    }
  }

  // 2. A dev server that takes longer than the 1.5 s probe on its first page (it is
  // compiling) is not hidden for five minutes: asking for a key probes it again, and
  // discovery asks again after 30 seconds.
  {
    const slow = () => {
      let warm = null;
      return http.createServer(async (req, res) => {
        warm ??= sleep(2000);
        await warm;
        res.writeHead(200, { "content-type": "text/html" }).end("<title>Compiled</title>");
      });
    };
    const opened = slow();
    const listed = slow();
    const openedPort = await listen(opened);
    const listedPort = await listen(listed);
    await writeFile(listing, row(openedPort, 201) + row(listedPort, 202));
    const browser = fakeBrowser();
    try {
      assert.deepEqual(await browser.services(), [], "both are still compiling when first probed");
      await sleep(700); // both have finished their first page by now
      const minted = await mint(browser, openedPort);
      assert.equal(minted.status, 201, `asking for a key probes a slow port again (got ${minted.status} ${JSON.stringify(minted.value)})`);
      later(31_000);
      const ports = (await browser.services()).map((service) => service.port);
      assert.ok(ports.includes(listedPort), "a port that only timed out is listed again after 30 seconds");
    } finally {
      Date.now = realNow;
      await close(opened);
      await close(listed);
    }
  }

  // 3. Suggestions survive a WORK/pages that is a plain file or links out of WORK.
  for (const shape of ["file", "outside link"]) {
    const work = join(scratch, `work-${shape.replace(" ", "-")}`);
    await mkdir(work, { recursive: true });
    if (shape === "file") await writeFile(join(work, "pages"), "not a folder");
    else {
      const notes = join(scratch, "notes");
      await mkdir(notes, { recursive: true });
      await writeFile(join(notes, "secret.md"), "# Secret\n");
      await symlink(notes, join(work, "pages"));
    }
    const replies = [];
    const workbench = createWorkbench({
      work,
      send: (res, status, value) => replies.push({ status, value }),
      jsonBody: async () => ({}),
      tools: { pages: createPages({ work }), browser: { services: async () => [{ port: 4321, title: "Dev", status: 200 }], handle: async () => false } },
      extensionUis: () => [{ title: "Charts", hash: "abc" }],
    });
    await workbench.handle({ method: "GET", headers: {} }, {}, new URL("http://l/api/workbench/suggestions"));
    assert.deepEqual(replies.at(-1), {
      status: 200,
      value: { suggestions: [{ kind: "service", title: "Dev", port: 4321 }, { kind: "extension", title: "Charts", hash: "abc" }] },
    }, `a pages ${shape} leaves services and extensions listed`);
  }

  // 4. Changes never echoes an absolute host path: a dangling symlink is a plain 404.
  {
    const work = join(scratch, "work-changes");
    await mkdir(work, { recursive: true });
    await symlink(join(scratch, "nowhere"), join(work, "gone"));
    const changes = createChanges({ work });
    const failure = await changes
      .handle({ method: "GET", headers: {} }, {}, new URL("http://l/api/workbench/changes?repo=gone"), "changes", { send: () => assert.fail("no reply expected") })
      .then(() => null, (error) => error);
    assert.ok(failure, "a dangling repo path is refused");
    assert.ok(!failure.message.includes(scratch) && !failure.message.includes("/"), `no host path in "${failure.message}"`);
    assert.equal(failure.status, 404, `a missing repo is 404 (got ${failure.status} ${failure.message})`);
  }
} finally {
  Date.now = realNow;
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  "PASS workbench night: a key stops when its port's owner is hidden or gone, a slow first page is probed again, Suggestions survive a broken pages folder, Changes errors carry no host path",
);
process.exit(0);

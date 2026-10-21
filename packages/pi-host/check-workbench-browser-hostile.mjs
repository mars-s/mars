// Hostile-service regressions from the second security review: a malformed keyed path,
// an invalid upstream status, ReDoS-shaped HTML, a trickling body and a request flood
// must never crash or freeze the host. Real host, temporary root, no model calls.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { htmlTitle, injectBase, rewriteHtml } from "./workbench/browser.mjs";
import { startHost } from "./workbench/test-host.mjs";

// Linear rewriting: a megabyte of unclosed tags must take milliseconds, not minutes.
const hostile = "<script ".repeat(120_000) + "<base " .repeat(20_000) + "<head ".repeat(20_000);
let started = Date.now();
rewriteHtml(hostile, "/api/workbench/browse/5173/~k");
injectBase(Buffer.from(hostile), { port: 5173, key: "k", path: "/", upstream: "http://127.0.0.1:5173" });
htmlTitle("<title " + "x".repeat(200_000));
assert.ok(Date.now() - started < 1500, `rewriting ${hostile.length} hostile bytes took ${Date.now() - started} ms`);

// A service that probes as normal HTTP but misbehaves on chosen paths.
const big = "<!doctype html><html><head><title>Hostile</title></head><body>" + "<script ".repeat(400_000);
const service = net.createServer((socket) =>
  socket.once("data", (data) => {
    const line = data.toString().split("\r\n")[0];
    if (line.startsWith("GET /weird")) return socket.end("HTTP/1.1 099 Odd\r\ncontent-length: 0\r\n\r\n");
    if (line.startsWith("GET /redos")) return socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${big.length}\r\n\r\n${big}`);
    if (line.startsWith("GET /trickle")) {
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 100\r\n\r\nx");
      return; // then silence
    }
    if (line.startsWith("GET /slow")) return setTimeout(() => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"), 4000);
    socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 27\r\n\r\n<title>Hostile</title>hello");
  }),
);
const port = await new Promise((resolve) => service.listen(0, "127.0.0.1", () => resolve(service.address().port)));
const host = await startHost({ MARS_WORKBENCH_PORTS: String(port), MARS_WORKBENCH_BODY_IDLE_MS: "1500" });
const alive = async (why) => assert.equal((await host.request("/api/workbench/capabilities")).status, 200, `the host is still up after ${why}`);
try {
  const key = (await host.request("/api/workbench/browse-key", { method: "POST", body: { port } })).json.key;
  const keyed = (path) => host.request(`/api/workbench/browse/${port}/~${key}${path}`, { auth: false }).catch((error) => ({ status: error.code }));

  const odd = await keyed("//[");
  assert.ok(typeof odd.status === "number", "an unparsable keyed path gets an answer, not a reset");
  await alive("a keyed //[ path");
  assert.equal((await keyed("/weird")).status, 502, "an invalid upstream status becomes 502");
  await alive("status 099");

  started = Date.now();
  const during = keyed("/redos");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ping = Date.now();
  await alive("ReDoS-shaped HTML");
  assert.ok(Date.now() - ping < 1000, `owner requests stay responsive during hostile HTML (${Date.now() - ping} ms)`);
  const rewritten = await during;
  assert.equal(rewritten.status, 200, "hostile HTML under the rewrite cap is rewritten and served");
  assert.ok(Date.now() - started < 3000, `and quickly (${Date.now() - started} ms)`);

  started = Date.now();
  const trickle = await keyed("/trickle");
  assert.ok(Date.now() - started < 8000, `a body that goes quiet is cut off (${Date.now() - started} ms, ${trickle.status})`);
  assert.ok(trickle.status === "ECONNRESET" || trickle.truncated || trickle.status === 504, `trickle ended: ${trickle.status}`);
  await alive("a trickling body");

  // Flood: requests beyond the in-flight cap are refused quickly instead of piling up.
  const flood = await Promise.all(Array.from({ length: 40 }, () => keyed("/slow")));
  const refused = flood.filter((reply) => reply.status === 503).length;
  assert.ok(refused >= 20, `in-flight cap refuses the excess (${refused} of 40 refused)`);
  await alive("a flood");
  console.log(`PASS workbench browser hostile service: linear rewriting, bad path and bad status are errors not crashes, host responsive during hostile HTML, quiet bodies cut off, flood capped (${refused} of 40 refused)`);
} finally {
  await host.stop();
  service.close();
}

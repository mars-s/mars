// Connectors end to end without network (docs/CONNECTORS.md "Tests"): address rules, an MCP
// server over Streamable HTTP with SSE, one over stdio, the OAuth code flow with dynamic
// client registration, state and PKCE, refresh, tool names and schemas, plugin switches,
// secrets kept out of every result, removal, an HTTP API connector, then the same flow
// through a real host's /api/connectors and its unauthenticated OAuth callback.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginRegistry } from "./plugin-registry.mjs";
import { CALLBACK_PATH, builtInConnectors, checkConnectorUrl, checkDiscoveredUrl, createConnectors, splitCommand } from "./connectors.mjs";
import { startFakeApi, startFakeMcp, startFakeOAuth } from "./connector-fakes.mjs";
import { hostSecrets } from "./secrets.mjs";
import { startHost } from "./workbench/test-host.mjs";

const KEY = "key-" + "k".repeat(24);
const API_KEY = "api-" + "a".repeat(24);
const STDIO_KEY = "stdio-" + "s".repeat(24);
const fakeDns = { "public.example": ["93.184.216.34"], "inside.example": ["192.168.1.20"], "mixed.example": ["93.184.216.34", "10.0.0.8"], "home.example": ["127.0.0.1"] };
const lookup = async (host) => {
  if (!fakeDns[host]) throw Error("ENOTFOUND");
  return fakeDns[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const proven = [];
const prove = (what) => proven.push(what);

// ---- Address rules ----
const refuses = (url, options, pattern) => assert.rejects(checkConnectorUrl(url, { lookup, ownPorts: [3081, 3082], ...options }), pattern, url);
await refuses("not a url", {}, /full URL/);
await refuses("ftp://public.example/x", {}, /Only http/);
await refuses("https://user:pw@public.example/mcp", {}, /credentials/);
await refuses("http://public.example/mcp", {}, /https/);
await refuses("https://10.1.2.3/mcp", {}, /private network/);
await refuses("https://169.254.169.254/latest", {}, /private network/);
await refuses("https://100.101.102.103/mcp", {}, /private network/);
await refuses("https://[fd00::1]/mcp", {}, /private network/);
await refuses("https://inside.example/mcp", {}, /private network/);
await refuses("https://mixed.example/mcp", {}, /private network/);
await refuses("http://127.0.0.1:3081/api", {}, /Mars itself/);
await refuses("https://nowhere.example/mcp", {}, /Cannot find/);
assert.equal((await checkConnectorUrl("https://public.example/mcp", { lookup })).host, "public.example");
assert.equal((await checkConnectorUrl("http://127.0.0.1:9999/mcp", { lookup, ownPorts: [3081] })).port, "9999");
assert.equal((await checkConnectorUrl("http://home.example:9999/mcp", { lookup })).hostname, "home.example");
assert.equal((await checkConnectorUrl("http://192.168.1.20:8080/mcp", { lookup, allowPrivate: true })).port, "8080");
await assert.rejects(checkDiscoveredUrl("http://127.0.0.1:9/token", "https://public.example/mcp", { lookup }), /local or private/);
await assert.rejects(checkDiscoveredUrl("https://inside.example/token", "https://public.example/mcp", { lookup }), /local or private/);
await assert.rejects(checkDiscoveredUrl("http://other.example/token", "https://public.example/mcp", { lookup: async () => [{ address: "93.184.216.35" }] }), /without https/);
assert.ok(await checkDiscoveredUrl("http://127.0.0.1:9/token", "http://127.0.0.1:8/mcp", { lookup }));
assert.deepEqual(splitCommand("npx -y \"@scope/pkg name\" 'a b'"), ["npx", "-y", "@scope/pkg name", "a b"]);
prove("address rules: https outside loopback, private and link-local refused unless allowed, names resolved, Mars's own ports refused, discovered URLs held to the connector host or public https");

// ---- In process ----
const base = await mkdtemp(join(tmpdir(), "mars connectors "));
const dataDir = join(base, "data");
const plugins = await createPluginRegistry({ root: join(dataDir, "plugin-settings") });
let clock = Date.now();
const as = await startFakeOAuth();
const keyed = await startFakeMcp({ verify: (token) => token === KEY });
const signed = await startFakeMcp({ verify: (token) => as.valid(token), authServer: () => as.origin });
const plain = await startFakeMcp({ sse: false });
const api = await startFakeApi({ key: API_KEY });
const ORIGIN = "http://127.0.0.1:3999";
const manager = createConnectors({
  dataDir,
  registry: plugins.registry,
  work: base,
  ownPorts: [3999],
  redirectOrigin: () => ORIGIN,
  builtIn: () => builtInConnectors({ connections: { status: () => ({ discord: { configured: false, connected: false }, opencode: { configured: true } }) }, composio: null }),
  env: { ...process.env, MARS_PI_TOKEN: "host-secret-" + "h".repeat(20) },
  now: () => clock,
});
plugins.registry.install(manager.extension);
await manager.boot();
const agentTool = (name) => plugins.registry.snapshot().tools().find(({ tool }) => tool.name === name)?.tool;
const run = async (name, args = {}) => {
  const tool = agentTool(name);
  assert.ok(tool, "tool " + name + " is offered");
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return (await tool.execute(prepared, {}, {})).structuredOutput;
};
const toolNames = () => plugins.registry.snapshot().tools().map(({ tool }) => tool.name);

try {
  // MCP over Streamable HTTP with a key, SSE replies, pagination and sessions.
  const added = await run("connector_add", { name: "Fake HTTP", url: keyed.url, key: KEY });
  assert.equal(added.connector.id, "fake-http");
  assert.equal(added.connector.hasKey, true);
  assert.deepEqual(added.connector.auth, { type: "key", header: "Authorization" });
  await assert.rejects(run("connector_add", { name: "fake http", url: keyed.url }), /already exists/);
  const connected = await run("connector_connect", { connector: "Fake HTTP" });
  assert.equal(connected.status, "connected", JSON.stringify(connected));
  assert.deepEqual(connected.connector.tools, ["conn_fake_http_echo", "conn_fake_http_add_numbers", "conn_fake_http_leak_token", "conn_fake_http_fail"]);
  prove("discovery over two tools/list pages and Mars names conn_<id>_<tool>, sanitised");
  const echo = agentTool("conn_fake_http_echo");
  assert.equal(echo.deferred, true);
  assert.deepEqual(echo.parameters, { type: "object", properties: { text: { type: "string", description: "Text to echo." } }, required: ["text"] });
  assert.match(echo.description, /^Echo the text back\.\nFrom the "Fake HTTP" connector \(MCP tool echo\)/);
  assert.match(echo.description, /Example: await tools\.conn_fake_http_echo\(\{"text":"\.\.\."\}\)$/);
  assert.equal(agentTool("conn_fake_http_add_numbers").parameters.$schema, undefined);
  const row = plugins.list().find((plugin) => plugin.name === "connector-fake-http");
  assert.equal(row.kind, "mcp");
  assert.equal(row.title, "Fake HTTP");
  prove("tools are deferred with the server's description and input schema, in one mcp plugin per connector");
  const reply = (await echo.execute({ text: "hello" }, {}, {})).structuredOutput;
  assert.deepEqual(reply, { text: "echo: hello", truncated: false });
  // The ping answer is posted alongside the reply, so give it a moment to land.
  for (let n = 0; n < 100 && !keyed.state.pingAnswered; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(keyed.state.pingAnswered, true, "the server's ping inside an SSE stream is answered");
  const sum = (await agentTool("conn_fake_http_add_numbers").execute({ a: 2, b: 3 }, {}, {})).structuredOutput;
  assert.deepEqual(sum, { text: "5", truncated: false, structured: { sum: 5 } });
  await assert.rejects(agentTool("conn_fake_http_fail").execute({}, {}, {}), /the fake tool failed/);
  const leak = (await agentTool("conn_fake_http_leak_token").execute({}, {}, {})).structuredOutput;
  assert.equal(leak.text, "I saw Bearer [redacted]");
  prove("tool call round trip over SSE (split events, notifications skipped, server ping answered), structured results, isError raised, echoed key redacted");
  assert.equal(keyed.state.initializes, 1);
  keyed.expireSessions();
  assert.equal((await echo.execute({ text: "again" }, {}, {})).structuredOutput.text, "echo: again");
  assert.equal(keyed.state.initializes, 2, "a 404 on the session starts one new session");
  assert.equal(keyed.state.lastHeaders["mcp-protocol-version"], "2025-06-18");
  prove("Mcp-Session-Id kept, MCP-Protocol-Version sent, a lost session re-initialised once");

  // Plugin switches hide connector tools.
  await plugins.set({ name: "connector-fake-http", tools: { conn_fake_http_echo: false } });
  assert.ok(!toolNames().includes("conn_fake_http_echo") && toolNames().includes("conn_fake_http_fail"));
  await plugins.set({ name: "connector-fake-http", enabled: false });
  assert.ok(!toolNames().some((name) => name.startsWith("conn_fake_http_")));
  await plugins.set({ name: "connector-fake-http", enabled: true, tools: { conn_fake_http_echo: true } });
  assert.ok(toolNames().includes("conn_fake_http_echo"));
  prove("Extensions switches hide one connector tool or the whole connector");

  // A wrong key is reported, not thrown, and needs a new key.
  const wrong = await run("connector_connect", { connector: "fake-http", key: "wrong-key-" + "w".repeat(20) });
  assert.equal(wrong.status, "needs_auth");
  assert.match(wrong.connector.lastError, /refused the key/);
  assert.equal((await run("connector_connect", { connector: "fake-http", key: KEY })).status, "connected");

  // JSON replies (no SSE) and auth none.
  await run("connector_add", { name: "Plain", url: plain.url });
  assert.equal((await run("connector_connect", { connector: "plain" })).connector.toolCount, 4);
  assert.equal((await agentTool("conn_plain_echo").execute({ text: "json" }, {}, {})).structuredOutput.text, "echo: json");
  prove("plain JSON replies work as well as SSE");

  // OAuth: a 401 challenge switches auth none to OAuth, discovery, registration, PKCE, state.
  await run("connector_add", { name: "Fake OAuth", url: signed.url });
  const started = await run("connector_connect", { connector: "fake-oauth" });
  assert.equal(started.status, "needs_auth");
  assert.equal(started.connector.auth.type, "oauth");
  const link = new URL(started.authorizationUrl);
  assert.equal(link.origin + link.pathname, as.origin + "/authorize");
  assert.equal(link.searchParams.get("code_challenge_method"), "S256");
  assert.equal(link.searchParams.get("redirect_uri"), ORIGIN + CALLBACK_PATH);
  assert.equal(link.searchParams.get("resource"), signed.url);
  assert.equal(link.searchParams.get("scope"), "mcp:tools");
  assert.ok(link.searchParams.get("state").length >= 43);
  assert.equal(as.counts.registrations, 1);
  assert.match(started.next, /Markdown link/);
  await assert.rejects(manager.finishSignIn({ state: "made-up-state", code: "x" }), /expired or was already used/);
  const authorize = await fetch(link, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const back = new URL(authorize.headers.get("location"));
  assert.equal(back.origin + back.pathname, ORIGIN + CALLBACK_PATH);
  await assert.rejects(manager.finishSignIn({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), iss: "https://impostor.example" }), /different server/);
  // The fake server really checks PKCE: that unspent code with a wrong verifier is refused.
  const forged = await fetch(as.origin + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: ORIGIN + CALLBACK_PATH, client_id: link.searchParams.get("client_id"), code_verifier: "wrong-verifier" }) });
  assert.equal(forged.status, 400);
  assert.equal(as.counts.pkceFailures, 1);
  // That state is spent; sign in again for a fresh one.
  const again = new URL((await run("connector_connect", { connector: "fake-oauth" })).authorizationUrl);
  assert.equal(as.counts.registrations, 1, "the registered client is reused for the same redirect URI");
  const back2 = new URL((await fetch(again, { redirect: "manual" })).headers.get("location"));
  const finished = await manager.finishSignIn(Object.fromEntries(["state", "code", "iss"].map((k) => [k, back2.searchParams.get(k)])));
  assert.equal(finished.status, "connected", JSON.stringify(finished));
  assert.equal(finished.toolCount, 4);
  assert.equal(as.counts.codeGrants, 1);
  assert.equal(as.counts.pkceFailures, 1, "Mars's verifier matched the challenge");
  await assert.rejects(manager.finishSignIn(Object.fromEntries(["state", "code", "iss"].map((k) => [k, back2.searchParams.get(k)]))), /already used/);
  prove("OAuth: 401 challenge, protected resource and authorization server metadata, dynamic client registration, PKCE S256 accepted by the server, state single use, iss checked");
  const signedEcho = agentTool("conn_fake_oauth_echo");
  assert.equal((await signedEcho.execute({ text: "signed" }, {}, {})).structuredOutput.text, "echo: signed");
  assert.equal((await agentTool("conn_fake_oauth_leak_token").execute({}, {}, {})).structuredOutput.text, "I saw Bearer [redacted]");

  // Refresh before expiry, and once on a 401.
  clock += 2 * 3600 * 1000;
  assert.equal((await signedEcho.execute({ text: "later" }, {}, {})).structuredOutput.text, "echo: later");
  assert.equal(as.counts.refreshGrants, 1, "an access token near expiry is refreshed first");
  as.revokeAccess();
  assert.equal((await signedEcho.execute({ text: "revoked" }, {}, {})).structuredOutput.text, "echo: revoked");
  assert.equal(as.counts.refreshGrants, 2, "a 401 refreshes once and retries");
  prove("tokens refresh before they expire and once on a 401");
  as.revokeAccess();
  as.revokeRefresh();
  await assert.rejects(signedEcho.execute({ text: "x" }, {}, {}), /could not be renewed|sign-in/i);
  assert.equal((await run("connector_list")).connectors.find((c) => c.id === "fake-oauth").status, "needs_auth");
  prove("a failed refresh leaves the connector needing sign-in, with a plain message");

  // Stdio with a minimal environment and the key as an environment variable.
  await run("connector_add", { name: "Fake Stdio", command: process.execPath, args: [fileURLToPath(new URL("./connector-fake-stdio.mjs", import.meta.url))], auth: { type: "key", env: "FAKE_TOKEN" }, key: STDIO_KEY });
  const stdio = await run("connector_connect", { connector: "fake-stdio" });
  assert.deepEqual(stdio.connector.tools, ["conn_fake_stdio_env_names", "conn_fake_stdio_echo"], JSON.stringify(stdio));
  assert.equal((await agentTool("conn_fake_stdio_echo").execute({ text: "pipe" }, {}, {})).structuredOutput.text, "stdio echo: pipe");
  const names = JSON.parse((await agentTool("conn_fake_stdio_env_names").execute({}, {}, {})).structuredOutput.text);
  assert.ok(names.includes("FAKE_TOKEN") && names.includes("PATH"));
  assert.ok(!names.includes("MARS_PI_TOKEN"), "the host's own secrets are not inherited");
  assert.ok(names.every((name) => ["FAKE_TOKEN", "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM"].includes(name)), names.join(","));
  prove("stdio: framing, a non-JSON log line skipped, minimal environment with the key as a variable");

  // A plain HTTP API.
  await run("connector_add", { name: "Fake API", kind: "http", url: api.url, auth: { type: "key", header: "X-Api-Key" }, key: API_KEY });
  assert.equal((await run("connector_connect", { connector: "fake-api" })).status, "connected");
  const got = await run("connector_request", { connector: "fake-api", path: "/items", query: { limit: 2 } });
  assert.equal(got.status, 200);
  assert.deepEqual({ path: got.body.path, query: got.body.query, echoedKey: got.body.echoedKey, auth: got.body.auth }, { path: "/v1/items", query: { limit: "2" }, echoedKey: "[redacted]", auth: null });
  const posted = await run("connector_request", { connector: "fake-api", method: "POST", path: "/items", body: { name: "tide" } });
  assert.deepEqual(posted.body.body, { name: "tide" });
  const moved = await run("connector_request", { connector: "fake-api", path: "/moved" });
  assert.equal(moved.status, 302);
  assert.equal(moved.location, "http://127.0.0.1:1/elsewhere");
  await assert.rejects(run("connector_request", { connector: "fake-api", path: "/../admin" }), /stay under/);
  await assert.rejects(run("connector_request", { connector: "fake-api", path: "//evil.example/x" }), /path must start/);
  await assert.rejects(run("connector_request", { connector: "fake-api", path: "/x", headers: { "x-api-key": "mine" } }), /cannot be set/);
  await assert.rejects(run("connector_request", { connector: "fake-api", path: "/x", headers: { Authorization: "Bearer mine" } }), /cannot be set/);
  await assert.rejects(run("connector_request", { connector: "fake-http", path: "/x" }), /MCP connector/);
  prove("connector_request: credentials added, path kept under the base URL, redirects not followed, credential headers refused");

  // Secrets never leave the host.
  const listed = JSON.stringify(await run("connector_list"));
  const secretsText = await readFile(join(dataDir, "connector-secrets.json"), "utf8");
  const stored = JSON.parse(secretsText);
  const every = [KEY, API_KEY, STDIO_KEY, ...Object.values(stored).flatMap((s) => [s.accessToken, s.refreshToken, s.clientSecret]).filter(Boolean)];
  assert.ok(every.length >= 3);
  for (const secret of every) assert.ok(!listed.includes(secret), "connector_list holds no secret");
  const config = await readFile(join(dataDir, "connectors.json"), "utf8");
  for (const secret of every) assert.ok(!config.includes(secret), "connectors.json holds no secret");
  assert.equal((await stat(join(dataDir, "connector-secrets.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDir, "connectors.json"))).mode & 0o777, 0o600);
  const known = await hostSecrets({ dataDir, env: {} });
  for (const secret of [KEY, API_KEY, STDIO_KEY]) assert.ok(known.includes(secret), "host output redaction knows connector keys");
  assert.deepEqual((await run("connector_list")).builtIn.map((r) => [r.id, r.status]), [["discord", "not_set_up"], ["opencode", "connected"], ["github", "not_set_up"]]);
  prove("secrets kept in a 0600 file only, never in connector_list, connectors.json or tool output, and known to host redaction; built-in rows listed");

  // Removal cleans up tools, plugin, secrets, session and process.
  const deletedBefore = keyed.state.deleted;
  const removed = await run("connector_remove", { connector: "fake-http" });
  assert.deepEqual(removed, { removed: true, id: "fake-http", name: "Fake HTTP" });
  assert.ok(!toolNames().some((name) => name.startsWith("conn_fake_http_")));
  assert.ok(!plugins.list().some((plugin) => plugin.name === "connector-fake-http"));
  assert.equal(keyed.state.deleted, deletedBefore + 1, "the MCP session is ended with DELETE");
  assert.equal(JSON.parse(await readFile(join(dataDir, "connector-secrets.json"), "utf8"))["fake-http"], undefined);
  assert.ok(!(await readFile(join(dataDir, "connectors.json"), "utf8")).includes("fake-http"));
  await run("connector_remove", { connector: "fake-stdio" });
  await assert.rejects(run("connector_remove", { connector: "fake-stdio" }), /No connector/);
  prove("removal drops the tools, plugin, saved secrets and session");

  // Tools come back after a restart from the cache, without the network.
  const plugins2 = await createPluginRegistry({ root: join(dataDir, "plugin-settings") });
  const manager2 = createConnectors({ dataDir, registry: plugins2.registry, work: base, fetch: () => assert.fail("no network at boot") });
  await manager2.boot();
  assert.ok(plugins2.registry.snapshot().tools().some(({ tool }) => tool.name === "conn_plain_echo"));
  await manager.close();
  await manager2.close();
  prove("cached tools reinstall at boot with no network call");

  // ---- Through a real host ----
  const host = await startHost();
  try {
    assert.equal((await host.request("/api/connectors", { auth: false })).status, 401, "the API needs the owner");
    const add = await host.request("/api/connectors", { method: "POST", body: { name: "Host OAuth", url: signed.url, auth: { type: "oauth" } } });
    assert.equal(add.status, 201, add.text);
    assert.equal((await host.request("/api/connectors", { method: "POST", body: { name: "Bad", url: "http://10.0.0.1/mcp" } })).status, 400);
    const connect = await host.request("/api/connectors/host-oauth/connect", { method: "POST", body: {} });
    assert.equal(connect.status, 200, connect.text);
    const url = new URL(connect.json.authorizationUrl);
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:" + host.port + CALLBACK_PATH);
    const location = new URL((await fetch(url, { redirect: "manual" })).headers.get("location"));
    const bad = await host.request(CALLBACK_PATH + "?state=forged&code=x", { auth: false });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /expired or was already used/);
    const page = await host.request(location.pathname + location.search, { auth: false });
    assert.equal(page.status, 200, page.text);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.text, /Host OAuth is connected with 4 tools[\s\S]*return to Mars/);
    assert.equal((await host.request(location.pathname + location.search, { auth: false })).status, 400, "the callback works once");
    const listed = await host.request("/api/connectors");
    const one = listed.json.connectors.find((c) => c.id === "host-oauth");
    assert.equal(one.status, "connected");
    assert.equal(one.signedIn, true);
    assert.deepEqual(listed.json.builtIn.map((r) => r.id), ["discord", "opencode", "github"]);
    for (const token of as.tokens()) assert.ok(!listed.text.includes(token) && !page.text.includes(token), "no token over HTTP");
    let pluginRow = (await host.request("/api/plugins")).json.plugins.find((p) => p.name === "connector-host-oauth");
    assert.equal(pluginRow.kind, "mcp");
    assert.equal(pluginRow.tools.length, 4);
    await host.stop();
    const again2 = await startHost({}, host);
    try {
      pluginRow = (await again2.request("/api/plugins")).json.plugins.find((p) => p.name === "connector-host-oauth");
      assert.equal(pluginRow?.tools.length, 4, "connector tools come back after a host restart");
      const remove = await again2.request("/api/connectors/host-oauth/remove", { method: "POST", body: {} });
      assert.equal(remove.status, 200, remove.text);
      assert.ok(!(await again2.request("/api/plugins")).json.plugins.some((p) => p.name === "connector-host-oauth"));
      assert.equal((await again2.request("/api/connectors/host-oauth/connect", { method: "POST", body: {} })).status, 404);
    } finally {
      await again2.stop();
    }
  } finally {
    await host.stop().catch(() => {});
  }
  prove("real host: owner-only /api/connectors, private URL refused, OAuth through the unauthenticated callback page with state checked once, no token over HTTP, mcp plugin listed and kept after restart, removal");
} finally {
  await Promise.all([as, keyed, signed, plain, api].map((server) => server.close()));
}
console.log("PASS connectors:\n- " + proven.join("\n- "));

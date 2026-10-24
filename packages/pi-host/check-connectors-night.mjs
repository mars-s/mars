// Connector fixes from the 2026-10-24 night review (docs/CONNECTORS.md): IPv4-mapped IPv6
// addresses get their IPv4 class, a stdio server printing JSON that is not an object cannot
// crash the host, discovered tool metadata is scrubbed of the connector's key, tool names
// are unique across connectors, concurrent first calls share one stdio process, and a
// short key is still redacted from connector output. No network.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "./plugin-registry.mjs";
import { checkConnectorUrl, checkDiscoveredUrl, createConnectors, ipClass } from "./connectors.mjs";
import { McpClient, stdioTransport } from "./mcp-client.mjs";
import { redactText } from "./secrets.mjs";

const proven = [];
const prove = (what) => proven.push(what);
const noDns = async (host) => {
  throw Error("no DNS in this check: " + host);
};

// ---- IPv4-mapped IPv6 ----
await assert.rejects(checkConnectorUrl("https://[::ffff:127.0.0.1]:3000/", { ownPorts: [3000], lookup: noDns }), /Mars itself/);
await assert.rejects(checkConnectorUrl("https://[::ffff:169.254.169.254]/", { lookup: noDns }), /private network/);
await assert.rejects(checkConnectorUrl("https://[0:0:0:0:0:ffff:a00:1]/mcp", { lookup: noDns }), /private network/);
await assert.rejects(checkDiscoveredUrl("https://[::ffff:169.254.169.254]/", "https://example.com", { lookup: noDns }), /local or private/);
await assert.rejects(checkDiscoveredUrl("https://[::ffff:7f00:1]/token", "https://example.com", { lookup: noDns }), /local or private/);
const classes = {
  "::ffff:a9fe:a9fe": "private",
  "::ffff:169.254.169.254": "private",
  "0:0:0:0:0:ffff:7f00:1": "loopback",
  "::ffff:8.8.8.8": "public",
  "64:ff9b::a9fe:a9fe": "private",
  "::7f00:1": "private",
  "::1": "loopback",
  "0:0:0:0:0:0:0:1": "loopback",
  "::": "private",
  "fd12::1": "private",
  "fe80::1": "private",
  "ff02::1": "private",
  "2606:4700:4700::1111": "public",
  "2001:db8::ffff:a9fe:a9fe": "public",
};
for (const [address, kind] of Object.entries(classes)) assert.equal(ipClass(address), kind, address);
assert.equal((await checkConnectorUrl("https://[2606:4700:4700::1111]/mcp", { lookup: noDns })).hostname, "[2606:4700:4700::1111]");
prove("IPv4-mapped IPv6 in any spelling gets its IPv4 class: loopback own port, link-local metadata and private ranges refused");

// ---- A fake stdio MCP server, configured by a JSON argument ----
const base = await mkdtemp(join(tmpdir(), "mars connectors night "));
const fake = join(base, "fake-server.mjs");
await writeFile(
  fake,
  `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const config = JSON.parse(process.argv[2]);
const key = process.env.FAKE_TOKEN ?? "";
const fill = (value) => JSON.parse(JSON.stringify(value).split("{KEY}").join(key));
if (config.pidFile) appendFileSync(config.pidFile, process.pid + "\\n");
for (const line of config.prelude ?? []) process.stdout.write(line + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "night", version: "1" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools: fill(config.tools) } });
  if (message.method === "tools/call") {
    const name = message.params.name;
    if (name === "echo-key") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "key: " + key }], structuredContent: { key, nested: { [key]: [key, "ok"] } } } });
    if (name === "fail-key") return send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "refused " + key }] } });
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "server " + config.label + " tool " + name } ] } });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
`,
);
const server = (config) => ({ command: process.execPath, args: [fake, JSON.stringify(config)] });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const started = [];

// ---- Stdio: JSON that is not an object is skipped, not a crash ----
{
  const transport = stdioTransport({ ...server({ label: "noisy", prelude: ["null", "[]", "42", '"text"', "true"], tools: [{ name: "ping", inputSchema: { type: "object" } }] }), cwd: base, env: { PATH: process.env.PATH } });
  const client = new McpClient(transport, { setupMs: 10000 });
  const listed = await client.listTools();
  started.push(transport.pid);
  assert.deepEqual(listed.map((tool) => tool.name), ["ping"]);
  await transport.close();
  prove("stdio: null, a list, a number, a string and a boolean on stdout are skipped and the session still works");
}

const managers = [];
const make = async (dataDir) => {
  const plugins = await createPluginRegistry({ root: join(dataDir, "plugin-settings") });
  const manager = createConnectors({ dataDir, registry: plugins.registry, work: base, env: { PATH: process.env.PATH } });
  await manager.boot();
  managers.push(manager);
  return { manager, plugins, tool: (name) => plugins.registry.snapshot().tools().find(({ tool }) => tool.name === name)?.tool, names: () => plugins.registry.snapshot().tools().map(({ tool }) => tool.name) };
};

try {
  const dataDir = join(base, "data");
  const { manager, tool, names } = await make(dataDir);

  // ---- Discovered tool metadata never carries the key ----
  const LEAK = "leaky-" + "x".repeat(20);
  await manager.add({
    name: "Leaky",
    ...server({ label: "leaky", tools: [{ name: "account", description: "Tools for account {KEY}.\nSigned in with {KEY}.", inputSchema: { type: "object", properties: { token: { type: "string", default: "{KEY}", description: "Defaults to {KEY}" } } } }] }),
    auth: { type: "key", env: "FAKE_TOKEN" },
    key: LEAK,
  });
  const leaky = await manager.connect("leaky");
  assert.equal(leaky.connector.status, "connected", JSON.stringify(leaky));
  const account = tool("conn_leaky_account");
  assert.ok(account, "the leaky tool is installed");
  assert.ok(!account.description.includes(LEAK), account.description);
  assert.ok(!JSON.stringify(account.parameters).includes(LEAK), JSON.stringify(account.parameters));
  assert.match(account.description, /Tools for account \[redacted\]\./);
  assert.ok(!(await readFile(join(dataDir, "connectors.json"), "utf8")).includes(LEAK), "connectors.json holds no key");
  prove("discovery: the key echoed in a description and schema is redacted before it is cached in connectors.json or offered to the model");

  // ---- Tool names are unique across connectors ----
  await manager.add({ name: "foo", ...server({ label: "foo", tools: [{ name: "bar_baz", inputSchema: { type: "object" } }] }) });
  await manager.add({ name: "foo-bar", ...server({ label: "foo-bar", tools: [{ name: "baz", inputSchema: { type: "object" } }] }) });
  const first = (await manager.connect("foo")).connector.tools;
  const second = (await manager.connect("foo-bar")).connector.tools;
  assert.deepEqual(first, ["conn_foo_bar_baz"]);
  assert.deepEqual(second, ["conn_foo_bar_baz_2"], "foo-bar's baz must not take foo's conn_foo_bar_baz");
  const offered = names().filter((name) => name.startsWith("conn_foo_"));
  assert.equal(new Set(offered).size, offered.length, "no duplicate names: " + offered);
  assert.equal((await tool("conn_foo_bar_baz").execute({}, {}, {})).structuredOutput.text, "server foo tool bar_baz");
  assert.equal((await tool("conn_foo_bar_baz_2").execute({}, {}, {})).structuredOutput.text, "server foo-bar tool baz");
  assert.deepEqual((await manager.refresh("foo-bar")).connector.tools, ["conn_foo_bar_baz_2"], "a refresh keeps the allocated name");
  assert.deepEqual((await manager.refresh("foo")).connector.tools, ["conn_foo_bar_baz"]);
  prove("names: foo's bar_baz and foo-bar's baz get distinct names, each reaches its own server, and refreshes keep them");

  // ---- A short key is redacted at any length ----
  const SHORT = "abc12345";
  await manager.add({ name: "Shorty", ...server({ label: "shorty", tools: [{ name: "echo-key", inputSchema: { type: "object" } }, { name: "fail-key", inputSchema: { type: "object" } }] }), auth: { type: "key", env: "FAKE_TOKEN" }, key: SHORT });
  assert.equal((await manager.connect("shorty")).connector.status, "connected");
  const echoed = (await tool("conn_shorty_echo_key").execute({}, {}, {})).structuredOutput;
  assert.equal(echoed.text, "key: [redacted]");
  assert.ok(!JSON.stringify(echoed).includes(SHORT), JSON.stringify(echoed));
  assert.deepEqual(echoed.structured, { key: "[redacted]", nested: { "[redacted]": ["[redacted]", "ok"] } });
  await assert.rejects(tool("conn_shorty_fail_key").execute({}, {}, {}), (error) => !error.message.includes(SHORT) && /refused \[redacted\]/.test(error.message));
  assert.equal(redactText("echo: " + SHORT, [SHORT]), "echo: " + SHORT, "broad host-secret redaction keeps its 12 character minimum");
  prove("a short connector key is redacted from text, structured results and errors, while host-wide discovery keeps its minimum");

  // ---- Concurrent first calls after a restart share one stdio process ----
  const pidFile = join(base, "racer.pids");
  await manager.add({ name: "Racer", ...server({ label: "racer", pidFile, tools: [{ name: "whoami", inputSchema: { type: "object" } }] }), auth: { type: "key", env: "FAKE_TOKEN" }, key: "racer-" + "r".repeat(20) });
  assert.equal((await manager.connect("racer")).connector.status, "connected");
  await manager.close();
  const restarted = await make(dataDir);
  const replies = await Promise.all([1, 2, 3].map(() => restarted.manager.callTool("racer", "whoami", {})));
  assert.deepEqual(replies.map((reply) => reply.text), Array(3).fill("server racer tool whoami"));
  await restarted.manager.close();
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  started.push(...pids);
  assert.equal(pids.length, 2, "one process for connect, one shared by the three concurrent calls: " + pids);
  assert.deepEqual(pids.filter(alive), [], "every server process ends when the connectors close");
  prove("concurrent first calls share one client and one stdio process, and close ends it");
} finally {
  for (const manager of managers) await manager.close().catch(() => {});
  for (const pid of started) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  await rm(base, { recursive: true, force: true });
}

for (const line of proven) console.log("ok - " + line);
console.log("connector night fixes: " + proven.length + " groups passed");

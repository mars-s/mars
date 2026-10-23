// Loopback fakes for check-connectors.mjs (docs/CONNECTORS.md "Tests"): an MCP server over
// Streamable HTTP with SSE replies and sessions, and an OAuth authorization server with
// dynamic client registration and PKCE. No network beyond 127.0.0.1.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const random = () => randomBytes(18).toString("base64url");
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error.message) }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: "http://127.0.0.1:" + server.address().port }));
  });
}
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};

export const FAKE_TOOLS = [
  { name: "echo", description: "Echo the text back.\nUse it to test a round trip.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to echo." } }, required: ["text"] } },
  { name: "add-numbers", description: "Add two numbers.", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "Leak.Token", description: "Return the credentials the server received.", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
];

/**
 * A Streamable HTTP MCP server at <origin>/mcp. `verify(token)` turns on bearer auth with a
 * 401 challenge pointing at protected resource metadata for `authServer()`. Replies are SSE
 * (with a notification and a server ping first) unless `sse` is false.
 */
export async function startFakeMcp({ verify, authServer = () => "", sse = true, keyHeader = "authorization" } = {}) {
  const state = { sessions: new Set(), initializes: 0, pingAnswered: false, deleted: 0, sessionOnCalls: true, lastHeaders: {}, calls: [] };
  const { server, origin } = await listen(async (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && req.method === "GET")
      return json(res, 200, { resource: origin + "/mcp", authorization_servers: [authServer()], scopes_supported: ["mcp:tools"] });
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    state.lastHeaders = req.headers;
    if (verify) {
      const header = String(req.headers[keyHeader] || "");
      const token = keyHeader === "authorization" ? header.replace(/^Bearer /, "") : header;
      if (!token || !verify(token)) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"` });
        return res.end();
      }
    }
    const session = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      if (state.sessions.delete(session)) state.deleted++;
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const message = JSON.parse(await body(req));
    if (message.method !== "initialize") {
      if (!session) return json(res, 400, { error: "missing session" });
      if (!state.sessions.has(session)) return json(res, 404, { error: "unknown session" });
    }
    if (message.id === undefined || message.method === undefined) {
      if (message.id === "srv-ping" && message.result) state.pingAnswered = true;
      res.writeHead(202);
      return res.end();
    }
    let result;
    const headers = {};
    if (message.method === "initialize") {
      state.initializes++;
      const id = random();
      state.sessions.add(id);
      headers["mcp-session-id"] = id;
      result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fake-mcp", version: "1.0.0" } };
    } else if (message.method === "tools/list") {
      const second = message.params?.cursor === "page-2";
      result = second ? { tools: FAKE_TOOLS.slice(2) } : { tools: FAKE_TOOLS.slice(0, 2), nextCursor: "page-2" };
    } else if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params;
      state.calls.push({ name, args });
      if (name === "echo") result = { content: [{ type: "text", text: "echo: " + args.text }] };
      else if (name === "add-numbers") result = { content: [{ type: "text", text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } };
      else if (name === "Leak.Token") result = { content: [{ type: "text", text: "I saw " + (req.headers[keyHeader] || "nothing") }] };
      else if (name === "fail") result = { content: [{ type: "text", text: "the fake tool failed" }], isError: true };
      else return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool " + name } });
    } else return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    const reply = { jsonrpc: "2.0", id: message.id, result };
    if (!sse) return json(res, 200, reply, headers);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
    res.write(": comment line\n\n");
    res.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } }) + "\n\n");
    if (message.method === "tools/call") res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: "srv-ping", method: "ping" }) + "\n\n");
    // Split one event across two writes to prove the parser buffers.
    const text = "event: message\ndata: " + JSON.stringify(reply) + "\n\n";
    res.write(text.slice(0, 20));
    setTimeout(() => res.end(text.slice(20)), 5);
  });
  return {
    url: origin + "/mcp",
    origin,
    state,
    expireSessions: () => state.sessions.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** An OAuth 2.1 authorization server with dynamic client registration and PKCE S256. */
export async function startFakeOAuth({ accessSeconds = 3600 } = {}) {
  const clients = new Map();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const counts = { registrations: 0, codeGrants: 0, refreshGrants: 0, pkceFailures: 0 };
  let lastAuthorize = null;
  const issue = (client, resource) => {
    const accessToken = "at-" + random();
    const refreshToken = "rt-" + random();
    access.set(accessToken, { client, expires: Date.now() + accessSeconds * 1000, resource });
    refresh.set(refreshToken, { client, resource });
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: accessSeconds };
  };
  const { server, origin } = await listen(async (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register" && req.method === "POST") {
      const input = JSON.parse(await body(req));
      if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length) return json(res, 400, { error: "invalid_redirect_uri" });
      const id = "client-" + random();
      clients.set(id, { redirectUris: input.redirect_uris });
      counts.registrations++;
      return json(res, 201, { client_id: id, redirect_uris: input.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const p = Object.fromEntries(url.searchParams);
      lastAuthorize = p;
      const client = clients.get(p.client_id);
      if (!client || !client.redirectUris.includes(p.redirect_uri)) return json(res, 400, { error: "invalid_client" });
      if (p.response_type !== "code" || p.code_challenge_method !== "S256" || !p.code_challenge || !p.state) return json(res, 400, { error: "invalid_request" });
      const code = "code-" + random();
      codes.set(code, { client: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, resource: p.resource });
      const back = new URL(p.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.state);
      back.searchParams.set("iss", origin);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const p = Object.fromEntries(new URLSearchParams(await body(req)));
      if (p.grant_type === "authorization_code") {
        const grant = codes.get(p.code);
        codes.delete(p.code);
        if (!grant || grant.client !== p.client_id || grant.redirectUri !== p.redirect_uri) return json(res, 400, { error: "invalid_grant" });
        if (createHash("sha256").update(String(p.code_verifier || "")).digest("base64url") !== grant.challenge) {
          counts.pkceFailures++;
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        counts.codeGrants++;
        return json(res, 200, issue(p.client_id, grant.resource));
      }
      if (p.grant_type === "refresh_token") {
        const grant = refresh.get(p.refresh_token);
        refresh.delete(p.refresh_token);
        if (!grant || grant.client !== p.client_id) return json(res, 400, { error: "invalid_grant" });
        counts.refreshGrants++;
        return json(res, 200, issue(p.client_id, grant.resource));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    return json(res, 404, { error: "not found" });
  });
  return {
    origin,
    counts,
    lastAuthorize: () => lastAuthorize,
    valid: (token) => (access.get(token)?.expires ?? 0) > Date.now(),
    tokens: () => [...access.keys(), ...refresh.keys()],
    revokeAccess: () => access.clear(),
    revokeRefresh: () => refresh.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A plain JSON API at <origin>/v1 that needs X-Api-Key and echoes the request. */
export async function startFakeApi({ key }) {
  const { server, origin } = await listen(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.headers["x-api-key"] !== key) return json(res, 401, { error: "bad key" });
    if (url.pathname === "/v1/moved") {
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      return res.end();
    }
    const text = await body(req);
    return json(res, 200, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : null, echoedKey: req.headers["x-api-key"], auth: req.headers.authorization ?? null });
  });
  return { url: origin + "/v1", close: () => new Promise((resolve) => server.close(resolve)) };
}

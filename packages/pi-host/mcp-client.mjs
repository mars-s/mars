// A small MCP client for connectors (docs/CONNECTORS.md): JSON-RPC 2.0 over Streamable
// HTTP (JSON or SSE replies, Mcp-Session-Id) or over a local command's stdio. Written for
// Mars, with no SDK: initialize, tools/list with pagination, tools/call, timeouts and
// size caps.
import { spawn } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";
export const MAX_BYTES = 4 * 1024 * 1024;
const SETUP_MS = 30000;
const CALL_MS = 120000;

export class McpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

const reason = (error) =>
  error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "the server did not answer in time"
    : String(error?.cause?.code || error?.message || error).slice(0, 200);

/** A fetch body as text, refusing more than `max` bytes. */
export async function readCapped(response, max = MAX_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new McpError(`The server sent more than ${Math.round(max / 1024)} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a text/event-stream body, passing each JSON-RPC message in a `data:` event to
 * `onMessage` until it returns true. Returns true when a message ended the read.
 */
export async function readSse(response, onMessage, max = MAX_BYTES) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let data = [];
  const dispatch = async () => {
    if (!data.length) return false;
    const payload = data.join("\n");
    data = [];
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) if (message && (await onMessage(message))) return true;
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new McpError(`The server sent more than ${Math.round(max / 1024)} KB`);
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (await dispatch()) return true;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
      }
    }
    if (buffer.trim().startsWith("data:")) data.push(buffer.trim().slice(5).trim());
    return await dispatch();
  } finally {
    reader.cancel().catch(() => {});
  }
}

const answerServer = (message) =>
  message.method === "ping"
    ? { jsonrpc: "2.0", id: message.id, result: {} }
    : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Mars does not support " + String(message.method).slice(0, 80) } };

/**
 * Streamable HTTP transport. `headers()` supplies auth headers per request; `check(url)`
 * applies the address rules before every request. Redirects are never followed.
 */
export function httpTransport({ url, headers = async () => ({}), check = async () => {}, fetch = globalThis.fetch, maxBytes = MAX_BYTES }) {
  let sessionId = null;
  let protocol = null;
  async function post(message, timeoutMs, wantId) {
    await check(url);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(protocol ? { "mcp-protocol-version": protocol } : {}),
          ...(await headers()),
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError("Could not reach the server: " + reason(error));
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new McpError(`The server redirected to ${String(response.headers.get("location") || "another address").slice(0, 300)}; use that URL instead`, { status });
    }
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new McpError(status === 401 ? "The server needs sign-in" : "The server refused access", { status, authenticate: response.headers.get("www-authenticate") || "" });
    }
    if (status === 404 && sessionId && message.method !== "initialize") {
      await response.body?.cancel().catch(() => {});
      throw new McpError("The server ended the session", { status, sessionExpired: true });
    }
    if (!response.ok) {
      const text = await readCapped(response, 4096).catch(() => "");
      throw new McpError(`The server answered HTTP ${status}${text.trim() ? ": " + text.trim().slice(0, 200) : ""}`, { status });
    }
    if (message.method === "initialize") sessionId = response.headers.get("mcp-session-id") || null;
    if (wantId === undefined) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const type = response.headers.get("content-type") || "";
    if (type.includes("text/event-stream")) {
      let answer;
      try {
        await readSse(
          response,
          async (incoming) => {
            if (incoming.id === wantId && ("result" in incoming || "error" in incoming)) {
              answer = incoming;
              return true;
            }
            if (typeof incoming.method === "string" && incoming.id !== undefined) post(answerServer(incoming), 10000, undefined).catch(() => {});
            return false;
          },
          maxBytes,
        );
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError("The server stream failed: " + reason(error));
      }
      if (!answer) throw new McpError("The server closed the stream without answering");
      return answer;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readCapped(response, maxBytes));
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError("The server sent a reply that is not JSON");
    }
    const answer = (Array.isArray(parsed) ? parsed : [parsed]).find((item) => item && item.id === wantId);
    if (!answer) throw new McpError("The server's reply did not answer the request");
    return answer;
  }
  return {
    kind: "http",
    request: (message, timeoutMs) => post(message, timeoutMs, message.id),
    notify: (message) => post(message, 10000, undefined),
    setProtocol(value) {
      protocol = value;
    },
    reset() {
      sessionId = null;
      protocol = null;
    },
    async close() {
      const id = sessionId;
      sessionId = null;
      protocol = null;
      if (!id) return;
      try {
        await check(url);
        const response = await fetch(url, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(5000), headers: { "mcp-session-id": id, ...(await headers()) } });
        await response.body?.cancel().catch(() => {});
      } catch {
        // Ending a session is a courtesy; the server expires it anyway.
      }
    },
  };
}

/**
 * Stdio transport: newline-delimited JSON-RPC with a child process started on first use.
 * `env` is the whole environment the child gets (keep it minimal).
 */
export function stdioTransport({ command, args = [], env = {}, cwd, maxBytes = MAX_BYTES }) {
  let child = null;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  function fail(owner, error) {
    if (owner !== child) return;
    child = null;
    buffer = "";
    try {
      owner.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  function write(message) {
    child.stdin.write(JSON.stringify(message) + "\n");
  }
  function handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Some servers log plain text to stdout; skip it.
    }
    // A JSON log line such as null, a number or a list is not a message; skip it too.
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    if (typeof message.method === "string" && message.id !== undefined) return write(answerServer(message));
    const waiter = message.id !== undefined && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  }
  function start() {
    if (child) return;
    stderr = "";
    const current = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child = current;
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", (chunk) => {
      if (current !== child) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) handle(line);
      }
      if (buffer.length > maxBytes) fail(current, new McpError(`The local server sent a line over ${Math.round(maxBytes / 1024)} KB`));
    });
    current.stderr.setEncoding("utf8");
    current.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2048);
    });
    current.stdin.on("error", () => {});
    current.on("error", (error) => fail(current, new McpError(`Could not start ${command}: ${error.code || error.message}`)));
    current.on("close", (code, signal) =>
      fail(current, new McpError(`The local server stopped (${signal || "exit " + code})${stderr.trim() ? ": " + stderr.trim().slice(-300) : ""}`)),
    );
  }
  return {
    kind: "stdio",
    request(message, timeoutMs) {
      start();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new McpError(`The local server did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
        pending.set(message.id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        write(message);
      });
    },
    async notify(message) {
      start();
      write(message);
    },
    setProtocol() {},
    reset() {},
    get pid() {
      return child?.pid;
    },
    async close() {
      if (!child) return;
      const current = child;
      fail(current, new McpError("The connector was closed"));
      await new Promise((resolve) => {
        if (current.exitCode !== null || current.signalCode !== null) return resolve();
        current.once("close", resolve);
        setTimeout(resolve, 2000).unref();
      });
    },
  };
}

/** One MCP session over a transport. Initialises on first use and once more after a 404. */
export class McpClient {
  #transport;
  #next = 1;
  #ready = null;
  #setupMs;
  #callMs;
  info = null;
  constructor(transport, { setupMs = SETUP_MS, callMs = CALL_MS } = {}) {
    this.#transport = transport;
    this.#setupMs = setupMs;
    this.#callMs = callMs;
  }
  get transport() {
    return this.#transport;
  }
  async #raw(method, params, timeoutMs) {
    const id = this.#next++;
    const reply = await this.#transport.request({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, timeoutMs);
    if (reply.error) throw new McpError(`The server refused ${method}: ${String(reply.error.message ?? "error").slice(0, 300)}`, { rpcCode: reply.error.code });
    return reply.result && typeof reply.result === "object" ? reply.result : {};
  }
  initialize() {
    this.#ready ??= (async () => {
      const result = await this.#raw("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mars", version: "0.1.0" } }, this.#setupMs);
      this.#transport.setProtocol(typeof result.protocolVersion === "string" ? result.protocolVersion.slice(0, 40) : PROTOCOL_VERSION);
      await this.#transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.info = { serverInfo: result.serverInfo ?? null, protocolVersion: result.protocolVersion ?? null };
      return this.info;
    })().catch((error) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }
  async request(method, params, timeoutMs = this.#setupMs) {
    await this.initialize();
    try {
      return await this.#raw(method, params, timeoutMs);
    } catch (error) {
      if (!error.sessionExpired) throw error;
      this.#transport.reset();
      this.#ready = null;
      await this.initialize();
      return this.#raw(method, params, timeoutMs);
    }
  }
  /** Every tool, following nextCursor: up to 20 pages and 500 tools. */
  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20 && tools.length < 500; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      for (const tool of Array.isArray(result.tools) ? result.tools : []) if (tool && typeof tool.name === "string" && tool.name) tools.push(tool);
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools.slice(0, 500);
  }
  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} }, this.#callMs);
  }
  close() {
    this.#ready = null;
    return this.#transport.close();
  }
}

/** A tools/call result as text: text parts joined, other parts as short placeholders. */
export function resultText(result, max = 20000) {
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text") parts.push(String(item.text ?? ""));
    else if (item?.type === "image" || item?.type === "audio") parts.push(`[${item.type} ${String(item.mimeType || "").slice(0, 60)} not shown]`);
    else if (item?.type === "resource") parts.push(typeof item.resource?.text === "string" ? item.resource.text : `[resource ${String(item.resource?.uri ?? "").slice(0, 300)}]`);
    else if (item?.type === "resource_link") parts.push(`[resource ${String(item.uri ?? "").slice(0, 300)}]`);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.join("\n");
  const truncated = text.length > max;
  if (truncated) text = text.slice(0, max) + `\n[cut at ${max} of ${text.length} characters]`;
  return { text, truncated, isError: result?.isError === true };
}

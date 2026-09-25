import { createServer } from "node:http";
import { Effect } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { loadGatewayConfig } from "./config.js";
import { MarsAgentRuntime } from "./agentRuntime.js";
import type { GatewayClientMessage, GatewayServerMessage, ProviderConfig } from "./protocol.js";

const VERSION = "0.1.0";

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(data);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(ws: WebSocket, message: GatewayServerMessage) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

const config = await Effect.runPromise(loadGatewayConfig());
const runtime = new MarsAgentRuntime(config.workspace, config.provider);

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        gateway: "mars",
        mode: "local",
        version: VERSION,
        workspace: config.workspace,
        provider: runtime.publicProviderConfig,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/config/provider") {
      json(res, 200, runtime.publicProviderConfig);
      return;
    }
    if (req.method === "POST" && url.pathname === "/config/provider") {
      const body = (await readJson(req)) as Partial<ProviderConfig>;
      if (typeof body.apiKey !== "string" || typeof body.modelId !== "string") {
        json(res, 400, { error: "apiKey and modelId are required" });
        return;
      }
      runtime.configureProvider({
        apiKey: body.apiKey,
        modelId: body.modelId,
        baseUrl:
          typeof body.baseUrl === "string" && body.baseUrl.trim()
            ? body.baseUrl
            : "https://opencode.ai/zen/go/v1",
      });
      json(res, 200, runtime.publicProviderConfig);
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  send(ws, {
    type: "hello",
    gateway: "mars",
    mode: "local",
    version: VERSION,
    providerReady: runtime.providerReady,
  });
  ws.on("message", async (raw) => {
    let message: GatewayClientMessage;
    try {
      message = JSON.parse(raw.toString()) as GatewayClientMessage;
    } catch {
      send(ws, { type: "error", message: "Invalid JSON message" });
      return;
    }

    try {
      if (message.type === "hello") {
        send(ws, {
          type: "hello",
          gateway: "mars",
          mode: "local",
          version: VERSION,
          providerReady: runtime.providerReady,
        });
        return;
      }
      if (message.type === "session.create") {
        const sessionId = runtime.createSession();
        send(ws, { type: "session.created", requestId: message.requestId, sessionId });
        return;
      }
      if (message.type === "session.list") {
        send(ws, { type: "session.list", requestId: message.requestId, sessions: runtime.listSessions() });
        return;
      }
      if (message.type === "chat.cancel") {
        runtime.cancel(message.sessionId);
        send(ws, { type: "chat.cancelled", requestId: message.requestId, sessionId: message.sessionId });
        return;
      }
      if (message.type === "chat.send") {
        send(ws, { type: "chat.started", requestId: message.requestId, sessionId: message.sessionId });
        let stopReason: string | undefined;
        for await (const event of runtime.stream(message.sessionId, message.text)) {
          switch (event.type) {
            case "modelStreamUpdateEvent":
              if (
                event.event.type === "modelContentBlockDeltaEvent" &&
                event.event.delta.type === "textDelta"
              ) {
                send(ws, {
                  type: "chat.delta",
                  requestId: message.requestId,
                  sessionId: message.sessionId,
                  text: event.event.delta.text,
                });
              }
              break;
            case "beforeToolCallEvent":
              send(ws, {
                type: "tool.started",
                requestId: message.requestId,
                sessionId: message.sessionId,
                name: event.toolUse.name,
                input: event.toolUse.input,
              });
              break;
            case "afterToolCallEvent":
              send(ws, {
                type: "tool.finished",
                requestId: message.requestId,
                sessionId: message.sessionId,
                name: event.toolUse.name,
                result: event.result,
              });
              break;
            case "agentResultEvent":
              stopReason = String(event.result.stopReason ?? "endTurn");
              break;
          }
        }
        send(ws, { type: "chat.done", requestId: message.requestId, sessionId: message.sessionId, stopReason });
      }
    } catch (error) {
      send(ws, {
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        sessionId: "sessionId" in message ? message.sessionId : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[mars-gateway] local gateway listening on http://${config.host}:${config.port}`);
  console.log(`[mars-gateway] workspace ${config.workspace}`);
});

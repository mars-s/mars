export type ServerEvent =
  | { type: "hello"; gateway: "mars"; mode: "local" | "remote"; version: string; providerReady: boolean }
  | { type: "session.created"; requestId: string; sessionId: string }
  | { type: "session.list"; requestId: string; sessions: SessionSummary[] }
  | { type: "chat.started"; requestId: string; sessionId: string }
  | { type: "chat.delta"; requestId: string; sessionId: string; text: string }
  | { type: "tool.started"; requestId: string; sessionId: string; name: string; input?: unknown }
  | { type: "tool.finished"; requestId: string; sessionId: string; name: string; result?: unknown }
  | { type: "chat.done"; requestId: string; sessionId: string; stopReason?: string }
  | { type: "chat.cancelled"; requestId: string; sessionId: string }
  | { type: "error"; requestId?: string; sessionId?: string; message: string };

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface HealthState {
  ok: boolean;
  gateway: string;
  mode: "local" | "remote";
  version: string;
  workspace: string;
  provider: { baseUrl: string; modelId: string; providerReady: boolean };
}

export class GatewayClient {
  readonly httpUrl = window.marsDesktop?.gatewayHttpUrl ?? "http://127.0.0.1:3037";
  readonly wsUrl = window.marsDesktop?.gatewayWsUrl ?? "ws://127.0.0.1:3037/ws";
  #socket?: WebSocket;
  #listeners = new Set<(event: ServerEvent) => void>();

  onEvent(listener: (event: ServerEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async health(): Promise<HealthState> {
    const response = await fetch(`${this.httpUrl}/health`);
    if (!response.ok) throw new Error(`Gateway health check failed (${response.status})`);
    return response.json() as Promise<HealthState>;
  }

  async configureProvider(input: { apiKey: string; modelId: string; baseUrl: string }) {
    const response = await fetch(`${this.httpUrl}/config/provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Provider setup failed (${response.status})`);
    }
    return response.json();
  }

  connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.#socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Mars gateway")), { once: true });
      socket.addEventListener("message", (message) => {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        for (const listener of this.#listeners) listener(event);
      });
    });
  }

  send(message: object) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Mars gateway is not connected");
    this.#socket.send(JSON.stringify(message));
  }
}

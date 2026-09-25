export interface ProviderConfig {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}

export type GatewayClientMessage =
  | { type: "hello" }
  | { type: "session.create"; requestId: string }
  | { type: "session.list"; requestId: string }
  | { type: "chat.send"; requestId: string; sessionId: string; text: string }
  | { type: "chat.cancel"; requestId: string; sessionId: string };

export type GatewayServerMessage =
  | {
      type: "hello";
      gateway: "mars";
      mode: "local" | "remote";
      version: string;
      providerReady: boolean;
    }
  | { type: "session.created"; requestId: string; sessionId: string }
  | {
      type: "session.list";
      requestId: string;
      sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number }>;
    }
  | { type: "chat.started"; requestId: string; sessionId: string }
  | { type: "chat.delta"; requestId: string; sessionId: string; text: string }
  | {
      type: "tool.started";
      requestId: string;
      sessionId: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool.finished";
      requestId: string;
      sessionId: string;
      name: string;
      result?: unknown;
    }
  | {
      type: "chat.done";
      requestId: string;
      sessionId: string;
      stopReason?: string;
    }
  | { type: "chat.cancelled"; requestId: string; sessionId: string }
  | { type: "error"; requestId?: string; sessionId?: string; message: string };

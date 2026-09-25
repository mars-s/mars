import { randomUUID } from "node:crypto";
import { Agent } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import type { ProviderConfig } from "./protocol.js";
import { createWorkspaceTools } from "./tools.js";

interface SessionEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agent: Agent;
  activeAbort?: AbortController;
}

export class MarsAgentRuntime {
  readonly #sessions = new Map<string, SessionEntry>();
  #provider: ProviderConfig;

  constructor(
    private readonly workspace: string,
    provider: ProviderConfig,
  ) {
    this.#provider = { ...provider };
  }

  get providerReady(): boolean {
    return Boolean(this.#provider.apiKey?.trim() && this.#provider.modelId.trim());
  }

  get publicProviderConfig(): Omit<ProviderConfig, "apiKey"> & { providerReady: boolean } {
    return {
      baseUrl: this.#provider.baseUrl,
      modelId: this.#provider.modelId,
      providerReady: this.providerReady,
    };
  }

  configureProvider(next: ProviderConfig): void {
    this.#provider = {
      baseUrl: next.baseUrl.trim() || "https://opencode.ai/zen/go/v1",
      modelId: next.modelId.trim(),
      apiKey: next.apiKey?.trim() || undefined,
    };
    for (const session of this.#sessions.values()) session.activeAbort?.abort();
    this.#sessions.clear();
  }

  listSessions() {
    return [...this.#sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
  }

  createSession(): string {
    if (!this.providerReady) throw new Error("OpenCode Go is not configured yet");
    const id = randomUUID();
    const responsesModels = new Set([
      "gpt-5.6-luna",
      "grok-4.6",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
    ]);
    const sharedModelOptions = {
      apiKey: this.#provider.apiKey!,
      clientConfig: { baseURL: this.#provider.baseUrl },
      modelId: this.#provider.modelId,
    } as const;
    const model = responsesModels.has(this.#provider.modelId)
      ? new OpenAIModel({ api: "responses", ...sharedModelOptions })
      : new OpenAIModel({ api: "chat", ...sharedModelOptions });
    const agent = new Agent({
      id,
      name: "Mars",
      description: "A local, extensible personal coding and automation agent.",
      model,
      tools: createWorkspaceTools(this.workspace),
      contextManager: "auto",
      printer: false,
      systemPrompt:
        "You are Mars, a concise personal software agent. Work directly in the active workspace when asked. Use tools deliberately, preserve user work, explain important actions briefly, and prefer completing tasks over describing how to complete them.",
    });
    const now = Date.now();
    this.#sessions.set(id, { id, title: "New chat", createdAt: now, updatedAt: now, agent });
    return id;
  }

  cancel(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session?.activeAbort) return false;
    session.activeAbort.abort();
    session.activeAbort = undefined;
    return true;
  }

  async *stream(sessionId: string, text: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Unknown Mars session");
    if (session.activeAbort) throw new Error("This Mars session is already running");
    const abort = new AbortController();
    session.activeAbort = abort;
    session.updatedAt = Date.now();
    if (session.title === "New chat") session.title = text.trim().slice(0, 54) || "New chat";
    try {
      for await (const event of session.agent.stream(text, { cancelSignal: abort.signal })) {
        yield event;
      }
    } finally {
      session.activeAbort = undefined;
      session.updatedAt = Date.now();
    }
  }
}

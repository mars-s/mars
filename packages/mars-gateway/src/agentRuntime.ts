import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Agent, SessionManager } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { LocalFileStorage } from "@strands-agents/sdk/storage";
import type { ProviderConfig } from "./protocol.js";
import { SessionCatalog, type StoredSession } from "./sessionStore.js";
import { createWorkspaceTools } from "./tools.js";

interface SessionEntry {
  id: string;
  agent: Agent;
  activeAbort?: AbortController;
}

export class MarsAgentRuntime {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #catalog: SessionCatalog;
  readonly #sessionStorage: LocalFileStorage;
  #provider: ProviderConfig;

  constructor(
    private readonly workspace: string,
    provider: ProviderConfig,
    dataDir: string,
  ) {
    this.#provider = { ...provider };
    this.#catalog = new SessionCatalog(dataDir);
    this.#sessionStorage = new LocalFileStorage(join(dataDir, "strands", "v1"));
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

  listSessions(): StoredSession[] {
    return this.#catalog.list();
  }

  createSession(): string {
    if (!this.providerReady) throw new Error("OpenCode Go is not configured yet");
    const id = randomUUID();
    const now = Date.now();
    this.#catalog.create({ id, title: "New chat", createdAt: now, updatedAt: now });
    this.#sessions.set(id, { id, agent: this.#createAgent(id) });
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
    const metadata = this.#catalog.get(sessionId);
    if (!metadata) throw new Error("Unknown Mars session");
    const session = this.#getOrRestoreSession(sessionId);
    if (session.activeAbort) throw new Error("This Mars session is already running");

    const abort = new AbortController();
    session.activeAbort = abort;
    const title =
      metadata.title === "New chat" ? text.trim().slice(0, 54) || "New chat" : metadata.title;
    this.#catalog.update(sessionId, { title, updatedAt: Date.now() });

    try {
      for await (const event of session.agent.stream(text, { cancelSignal: abort.signal })) {
        yield event;
      }
    } finally {
      session.activeAbort = undefined;
      this.#catalog.update(sessionId, { updatedAt: Date.now() });
    }
  }

  #getOrRestoreSession(sessionId: string): SessionEntry {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    if (!this.providerReady) throw new Error("OpenCode Go is not configured yet");
    if (!this.#catalog.get(sessionId)) throw new Error("Unknown Mars session");
    const restored = { id: sessionId, agent: this.#createAgent(sessionId) };
    this.#sessions.set(sessionId, restored);
    return restored;
  }

  #createAgent(sessionId: string): Agent {
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
    const sessionManager = new SessionManager({
      sessionId,
      storage: this.#sessionStorage,
    });

    return new Agent({
      id: sessionId,
      name: "Mars",
      description: "A local, extensible personal coding and automation agent.",
      model,
      tools: createWorkspaceTools(this.workspace),
      contextManager: "auto",
      sessionManager,
      printer: false,
      systemPrompt:
        "You are Mars, a concise personal software agent. Work directly in the active workspace when asked. Use tools deliberately, preserve user work, explain important actions briefly, and prefer completing tasks over describing how to complete them.",
    });
  }
}

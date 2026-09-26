import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SESSION_INDEX_VERSION = 1;

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionIndexFile {
  version: typeof SESSION_INDEX_VERSION;
  sessions: StoredSession[];
}

export class SessionCatalog {
  readonly #entries = new Map<string, StoredSession>();
  readonly #indexPath: string;

  constructor(dataDir: string) {
    this.#indexPath = join(dataDir, "sessions", "v1", "index.json");
    this.#load();
  }

  list(): StoredSession[] {
    return [...this.#entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(sessionId: string): StoredSession | undefined {
    const session = this.#entries.get(sessionId);
    return session ? { ...session } : undefined;
  }

  create(session: StoredSession): void {
    if (this.#entries.has(session.id)) {
      throw new Error("Mars session already exists: " + session.id);
    }
    this.#entries.set(session.id, { ...session });
    this.#persist();
  }

  update(
    sessionId: string,
    patch: Partial<Pick<StoredSession, "title" | "updatedAt">>,
  ): StoredSession {
    const existing = this.#entries.get(sessionId);
    if (!existing) throw new Error("Unknown Mars session");
    const next = { ...existing, ...patch };
    this.#entries.set(sessionId, next);
    this.#persist();
    return { ...next };
  }

  #load(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(this.#indexPath, "utf8"),
      ) as Partial<SessionIndexFile>;
      if (
        parsed.version !== SESSION_INDEX_VERSION ||
        !Array.isArray(parsed.sessions)
      ) {
        throw new Error(
          "Unsupported Mars session index version: " + String(parsed.version),
        );
      }
      for (const candidate of parsed.sessions) {
        if (
          candidate &&
          typeof candidate.id === "string" &&
          typeof candidate.title === "string" &&
          typeof candidate.createdAt === "number" &&
          typeof candidate.updatedAt === "number"
        ) {
          this.#entries.set(candidate.id, { ...candidate });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(
        "[mars-gateway] could not read session index; starting with an empty catalog",
        error,
      );
    }
  }

  #persist(): void {
    mkdirSync(dirname(this.#indexPath), { recursive: true });
    if (existsSync(this.#indexPath)) {
      copyFileSync(this.#indexPath, this.#indexPath + ".bak");
    }
    const tempPath = this.#indexPath + ".tmp";
    const payload: SessionIndexFile = {
      version: SESSION_INDEX_VERSION,
      sessions: this.list(),
    };
    writeFileSync(
      tempPath,
      JSON.stringify(payload, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(tempPath, this.#indexPath);
    chmodSync(this.#indexPath, 0o600);
  }
}

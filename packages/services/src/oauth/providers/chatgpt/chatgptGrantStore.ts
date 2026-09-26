/**
 * App-owned ChatGPT grant store with cross-process refresh rotation.
 *
 * WHY THIS EXISTS
 *
 * ChatGPT refresh tokens are SINGLE-USE. The moment a refresh token is
 * submitted, the server rotates it and the old value is dead. Two processes that
 * both believe they hold the same refresh token will both submit it, and the
 * server revokes the entire token family, signing the user out of every client
 * that shares the grant. That is the worst outcome this feature can produce, so
 * the whole read -> POST -> write-back sequence runs under one cross-process
 * lock, and a process that finds a peer already rotated ADOPTS the stored pair
 * instead of replaying its stale refresh token.
 *
 * The store lives in this app's own data directory. It never reads or writes
 * another app's store, which is what makes "two profiles sharing one grant"
 * structurally impossible rather than merely unlikely.
 *
 * Token material is encrypted with the same AES-GCM cipher the credential store
 * already uses, and the file is written 0600. Plaintext on disk would be a
 * regression against the rest of this app's credential handling. Note that this
 * is a pure-Node cipher, NOT Electron `safeStorage`: a locked macOS keychain
 * makes every `safeStorage` call, including `isEncryptionAvailable()`, raise a
 * blocking dialog, so keychain encryption is deliberately never touched here.
 */
import { readFile, rm } from "node:fs/promises";
import {
  atomicWritePrivateTextFile,
  withFileLock,
  type SharedFileLockOptions,
} from "@zcode/shared/node";
import {
  CHATGPT_GRANT_LOCK_MAX_WAIT_MS,
  CHATGPT_GRANT_LOCK_RETRY_DELAYS_MS,
} from "./chatgptOAuthConfig.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "../../../credential/providers/credentialCipherProvider.js";
import { createServiceLogger } from "../../../logger/serviceLogger.js";

const log = createServiceLogger("chatgptGrantStore");

const GRANT_STORE_VERSION = 1;

export interface ChatGptStoredGrant {
  /** Monotonic count of successful rotations; lets callers reason about staleness. */
  readonly rotation: number;
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly expiresAt: number | null;
  readonly refreshToken: string;
  readonly updatedAt: number;
}

export type ChatGptRefreshStatus =
  /** The stored refresh token was current and has now been exchanged. */
  | "rotated"
  /** A peer process rotated first; its result was adopted without any network call. */
  | "adopted"
  /** No stored grant; the caller must start a fresh login. */
  | "unlocked";

export interface ChatGptRefreshOutcome {
  readonly grant: ChatGptStoredGrant | null;
  readonly status: ChatGptRefreshStatus;
}

/** Thrown when the server refuses the stored refresh token. The grant is unusable. */
export class ChatGptGrantRevokedError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      "ChatGPT refresh token was rejected by the authorization server; re-login is required",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ChatGptGrantRevokedError";
    this.reason = reason;
  }
}

export interface ChatGptGrantStoreOptions {
  /** Absolute path of the grant file; it doubles as the lock path. */
  readonly storePath: string;
  readonly now?: () => number;
  readonly lockOptions?: SharedFileLockOptions;
  /** Injection seam for tests. Production derives the key from the app secret. */
  readonly cipherProvider?: CredentialCipherProvider;
}

export interface ChatGptRotationRequest {
  /** The refresh token this process believes is current. */
  readonly expectedRefreshToken: string;
  /** Performs the exchange. Runs while the cross-process lock is held. */
  readonly exchange: (grant: ChatGptStoredGrant) => Promise<{
    accessToken: string;
    expiresAt: number | null;
    refreshToken: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEpochMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export class ChatGptGrantStore {
  private readonly cipherProvider: CredentialCipherProvider;
  private readonly now: () => number;
  private readonly storePath: string;
  private readonly lockOptions: SharedFileLockOptions;

  constructor(options: ChatGptGrantStoreOptions) {
    this.storePath = options.storePath;
    this.now = options.now ?? Date.now;
    this.cipherProvider = options.cipherProvider ?? createCredentialCipherProvider();
    this.lockOptions = {
      lockRetryDelaysMs: CHATGPT_GRANT_LOCK_RETRY_DELAYS_MS,
      lockMaxWaitMs: CHATGPT_GRANT_LOCK_MAX_WAIT_MS,
      ...options.lockOptions,
    };
  }

  async read(): Promise<ChatGptStoredGrant | null> {
    return readGrantFile(this.storePath, this.cipherProvider);
  }

  /** Writes a freshly obtained grant. Replaces any existing grant outright. */
  async write(
    grant: Omit<ChatGptStoredGrant, "rotation" | "updatedAt">,
  ): Promise<ChatGptStoredGrant> {
    const previous = await readGrantFile(this.storePath, this.cipherProvider);
    const next: ChatGptStoredGrant = {
      ...grant,
      rotation: (previous?.rotation ?? 0) + 1,
      updatedAt: this.now(),
    };
    await writeGrantFile(this.storePath, next, this.cipherProvider);
    return next;
  }

  async clear(): Promise<void> {
    await rm(this.storePath, { force: true });
  }

  /**
   * Rotates the grant under a cross-process lock.
   *
   * Ordering inside the lock is the whole safety property:
   *   1. read the stored grant,
   *   2. if the stored refresh token is not the one we hold, a peer already
   *      rotated it: adopt the stored pair and make NO network call,
   *   3. otherwise exchange the stored refresh token and write the new pair
   *      back before releasing the lock.
   *
   * Because the lock is held across the POST, a second process cannot observe a
   * half-rotated state, and it can never submit a token another process has
   * already spent.
   */
  async rotate(request: ChatGptRotationRequest): Promise<ChatGptRefreshOutcome> {
    return withFileLock(this.storePath, async () => this.rotateLocked(request), this.lockOptions);
  }

  private async rotateLocked(request: ChatGptRotationRequest): Promise<ChatGptRefreshOutcome> {
    const stored = await readGrantFile(this.storePath, this.cipherProvider);
    if (!stored) {
      log.info(undefined, "no stored ChatGPT grant; a fresh login is required");
      return { grant: null, status: "unlocked" };
    }

    if (stored.refreshToken !== request.expectedRefreshToken.trim()) {
      // The peer-rotated branch. Replaying our stale token here would be the
      // single most destructive thing this module could do, so the network is
      // never touched on this path.
      log.info(undefined, "adopted a ChatGPT grant a peer process already rotated", {
        rotation: stored.rotation,
      });
      return { grant: stored, status: "adopted" };
    }

    let exchanged: { accessToken: string; expiresAt: number | null; refreshToken: string };
    try {
      exchanged = await request.exchange(stored);
    } catch (error) {
      if (error instanceof ChatGptGrantRevokedError) {
        log.warn(undefined, "the stored ChatGPT grant was rejected; re-login is required", {
          reason: error.reason,
        });
      }
      throw error;
    }

    const next: ChatGptStoredGrant = {
      accountId: stored.accountId,
      accessToken: exchanged.accessToken,
      expiresAt: exchanged.expiresAt,
      refreshToken: exchanged.refreshToken,
      rotation: stored.rotation + 1,
      updatedAt: this.now(),
    };
    await writeGrantFile(this.storePath, next, this.cipherProvider);
    log.info(undefined, "rotated the ChatGPT grant", { rotation: next.rotation });
    return { grant: next, status: "rotated" };
  }
}

async function readGrantFile(
  storePath: string,
  cipherProvider: CredentialCipherProvider,
): Promise<ChatGptStoredGrant | null> {
  let raw: string;
  try {
    raw = await readFile(storePath, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }

  // Non-token metadata stays in the clear so a locked store is still diagnosable;
  // every field that carries credential material is decrypted individually.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or hand-edited file must not silently become "no grant", or a
    // later login would overwrite a grant that is still live elsewhere.
    throw new Error(`ChatGPT grant store is corrupt: ${storePath}`);
  }

  if (!isRecord(parsed) || parsed.version !== GRANT_STORE_VERSION) {
    throw new Error(`ChatGPT grant store has an unsupported shape: ${storePath}`);
  }

  const accessToken = decryptField(parsed.accessToken, cipherProvider, storePath);
  const refreshToken = decryptField(parsed.refreshToken, cipherProvider, storePath);
  if (!accessToken || !refreshToken) {
    throw new Error(`ChatGPT grant store is missing token material: ${storePath}`);
  }

  const rotation = parsed.rotation;
  return {
    accessToken,
    refreshToken,
    accountId: readNonEmptyString(decryptField(parsed.accountId, cipherProvider, storePath)),
    expiresAt: readEpochMillis(parsed.expiresAt),
    rotation:
      typeof rotation === "number" && Number.isSafeInteger(rotation) && rotation >= 0
        ? rotation
        : 0,
    updatedAt: readEpochMillis(parsed.updatedAt) ?? 0,
  };
}

function decryptField(
  value: unknown,
  cipherProvider: CredentialCipherProvider,
  storePath: string,
): string | null {
  const stored = readNonEmptyString(value);
  if (!stored) {
    return null;
  }
  try {
    return readNonEmptyString(cipherProvider.decrypt(stored));
  } catch (error) {
    throw new Error(`ChatGPT grant store could not be decrypted: ${storePath}`, { cause: error });
  }
}

async function writeGrantFile(
  storePath: string,
  grant: ChatGptStoredGrant,
  cipherProvider: CredentialCipherProvider,
): Promise<void> {
  // 0600 + atomic replace: the file holds a live subscription credential, and a
  // crash mid-write must never leave a half-written grant behind.
  await atomicWritePrivateTextFile(
    storePath,
    `${JSON.stringify(
      {
        version: GRANT_STORE_VERSION,
        rotation: grant.rotation,
        updatedAt: grant.updatedAt,
        expiresAt: grant.expiresAt,
        accessToken: cipherProvider.encrypt(grant.accessToken),
        refreshToken: cipherProvider.encrypt(grant.refreshToken),
        ...(grant.accountId ? { accountId: cipherProvider.encrypt(grant.accountId) } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

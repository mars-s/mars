/**
 * Device-code session state machine for the ChatGPT adapter.
 *
 * The frozen `OAuthProviderAdapter` seam has no device-code methods, so the flow
 * lives beside the adapter and is reached through `isDeviceCodeFlowAdapter`.
 * Exactly one session is live at a time, keyed by the OAuth `state` the service
 * already generates, so cancelling or replacing a login invalidates it.
 */
import type { OAuthTokenSet } from "@zcode/shared";
import {
  CHATGPT_DEVICE_POLL_MAX_INTERVAL_MS,
  CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS,
} from "./chatgptOAuthConfig.js";
import {
  ChatGptAuthorizationPendingError,
  ChatGptDeviceFlowTerminalError,
  type ChatGptDeviceAuthorization,
  type ChatGptDeviceCodeClient,
  type ChatGptTokenGrant,
} from "./chatgptDeviceFlow.js";
import { createServiceLogger } from "../../../logger/serviceLogger.js";

const log = createServiceLogger("chatgptDeviceFlow");

/** Public description of the login the user has to perform in a browser. */
export interface ChatGptDeviceFlowStart {
  readonly deviceCode: string;
  readonly expiresAt: number;
  readonly state: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
}

export interface ChatGptDeviceFlowCapability {
  readonly supportsDeviceCodeFlow: true;
  cancelDeviceFlow(state: string): void;
  /** Currently displayed login, or null when no device flow is live. */
  peekDeviceFlow(): ChatGptDeviceFlowStart | null;
  pollDeviceFlow(state: string): Promise<OAuthTokenSet | null>;
  startDeviceFlow(state: string): Promise<ChatGptDeviceFlowStart>;
}

interface LiveSession {
  authorization: ChatGptDeviceAuthorization;
  cancelled: boolean;
  nextPollAt: number;
  pollIntervalMs: number;
  readonly start: ChatGptDeviceFlowStart;
}

export function isDeviceCodeFlowAdapter(
  adapter: unknown,
): adapter is typeof adapter & ChatGptDeviceFlowCapability {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    (adapter as { supportsDeviceCodeFlow?: unknown }).supportsDeviceCodeFlow === true
  );
}

export interface ChatGptDeviceFlowSessionOptions {
  readonly client: ChatGptDeviceCodeClient;
  readonly now?: () => number;
  /** Converts a successful device grant into the persisted token set shape. */
  readonly toTokenSet: (grant: ChatGptTokenGrant) => Promise<OAuthTokenSet>;
  readonly redirectUri?: string;
}

export class ChatGptDeviceFlowSession implements ChatGptDeviceFlowCapability {
  readonly supportsDeviceCodeFlow = true as const;

  private readonly client: ChatGptDeviceCodeClient;
  private readonly now: () => number;
  private readonly redirectUri?: string;
  private readonly toTokenSet: (grant: ChatGptTokenGrant) => Promise<OAuthTokenSet>;
  private live: LiveSession | null = null;

  constructor(options: ChatGptDeviceFlowSessionOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.redirectUri = options.redirectUri;
    this.toTokenSet = options.toTokenSet;
  }

  peekDeviceFlow(): ChatGptDeviceFlowStart | null {
    return this.live?.start ?? null;
  }

  cancelDeviceFlow(state: string): void {
    if (!this.live || this.live.start.state !== state) {
      return;
    }
    this.live.cancelled = true;
    this.live = null;
  }

  async startDeviceFlow(state: string): Promise<ChatGptDeviceFlowStart> {
    const authorization = await this.client.requestDeviceAuthorization(
      this.redirectUri ? { redirectUri: this.redirectUri } : {},
    );
    const start: ChatGptDeviceFlowStart = {
      deviceCode: authorization.deviceCode,
      expiresAt: this.now() + authorization.expiresInSeconds * 1_000,
      state,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      ...(authorization.verificationUriComplete
        ? { verificationUriComplete: authorization.verificationUriComplete }
        : {}),
    };
    this.live = {
      authorization,
      cancelled: false,
      nextPollAt: 0,
      pollIntervalMs: Math.max(
        authorization.intervalSeconds * 1_000,
        CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS,
      ),
      start,
    };
    log.info(undefined, "ChatGPT device authorization started", {
      expiresInMs: authorization.expiresInSeconds * 1_000,
      intervalMs: this.live.pollIntervalMs,
    });
    return start;
  }

  /**
   * Advances the flow by at most one poll.
   *
   * Returns null while the user has not finished approving, and the token set
   * once the grant is issued. A non-terminal failure throws, which the service
   * surfaces as a login error.
   */
  async pollDeviceFlow(state: string): Promise<OAuthTokenSet | null> {
    const session = this.live;
    if (!session || session.start.state !== state || session.cancelled) {
      return null;
    }
    if (this.now() >= session.start.expiresAt) {
      this.live = null;
      throw new ChatGptDeviceFlowTerminalError(
        "expired_token",
        "The ChatGPT login code expired, please retry",
      );
    }
    if (this.now() < session.nextPollAt) {
      return null;
    }
    session.nextPollAt = this.now() + session.pollIntervalMs;

    try {
      const grant = await this.client.pollDeviceToken(session.authorization.deviceCode);
      this.live = null;
      log.info(undefined, "ChatGPT device authorization completed");
      return await this.toTokenSet(grant);
    } catch (error) {
      if (error instanceof ChatGptAuthorizationPendingError) {
        // RFC 8628 slow_down: widen the cadence instead of hammering the server.
        session.pollIntervalMs = Math.min(
          session.pollIntervalMs + CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS,
          CHATGPT_DEVICE_POLL_MAX_INTERVAL_MS,
        );
        return null;
      }
      this.live = null;
      throw error;
    }
  }
}

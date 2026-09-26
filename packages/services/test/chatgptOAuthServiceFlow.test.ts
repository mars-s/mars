/**
 * OAuthService-level tests for the ChatGPT device-code path.
 *
 * The service is the piece that decides when a flow starts, who drives it and
 * what survives a restart. These tests cover that wiring with an injected
 * adapter and an in-memory credential service, so no network and no real
 * account are involved.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setDataBaseDir } from "../src/paths.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import { ChatGptOAuthAdapter } from "../src/oauth/providers/chatgpt/chatgptOAuthAdapter.js";
import { createChatGptClient } from "../src/oauth/providers/chatgpt/chatgptDeviceFlow.js";

function makeAccessToken(accountId: string, expiresInSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    chatgpt_account_id: accountId,
    sub: "user-under-test",
    exp: Math.floor(Date.now() / 1_000) + expiresInSeconds,
  })}.sig`;
}

function createMemoryCredentialService(): ICredentialService & { dump(): Map<string, string> } {
  const values = new Map<string, string>();
  return {
    async load(key) {
      return values.get(key) ?? null;
    },
    async save(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    dump: () => values,
  };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-service-"));
  const previous = process.env.ZCODE_DATA_BASE_DIR;
  setDataBaseDir(dir);
  try {
    return await run(dir);
  } finally {
    setDataBaseDir(previous ?? null);
    await rm(dir, { recursive: true, force: true });
  }
}

interface Harness {
  /** The service holds a 5 minute login timer; cancel it so the test can exit. */
  cleanup: () => Promise<void>;
  credentials: ReturnType<typeof createMemoryCredentialService>;
  /** Moves the shared clock past the device poll cadence. */
  advance: (ms: number) => void;
  polls: () => number;
  service: OAuthService;
}

async function createHarness(
  options: { pendingPolls?: number; planStatus?: number } = {},
): Promise<Harness> {
  let polls = 0;
  // The device flow rate-limits polls to its server-issued cadence, so the test
  // drives a clock instead of sleeping.
  let clock = Date.now();
  const client = createChatGptClient({
    transport: async (url) => {
      if (url.endsWith("/oauth/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://auth.openai.com/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      polls += 1;
      const pending = (options.pendingPolls ?? 0) > 0;
      if (pending) {
        options.pendingPolls = (options.pendingPolls ?? 0) - 1;
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: makeAccessToken("acct-service", 3600),
          refresh_token: `rt-${polls}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const adapter = new ChatGptOAuthAdapter({
    client,
    now: () => clock,
    grantStorePath: join(tmpdir(), `zcode-chatgpt-service-${process.pid}.json`),
    fetchImpl: async () =>
      new Response(JSON.stringify({ chatgpt_plan_type: "pro" }), {
        status: options.planStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  const credentials = createMemoryCredentialService();
  const service = new OAuthService(credentials, { adapters: [adapter], now: () => clock });
  return {
    service,
    credentials,
    polls: () => polls,
    advance: (ms) => {
      clock += ms;
    },
    cleanup: () => service.cancelPending(),
  };
}

/** Runs a harness body and always tears the pending login timer down. */
async function withHarness(
  options: Parameters<typeof createHarness>[0],
  run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

test("the service starts a device-code login and returns the code to the UI", async () => {
  await withTempDir(async () => {
    await withHarness({}, async ({ service }) => {
      const providers = await service.getProviders();
      assert.deepEqual(
        providers.map((provider) => provider.id),
        ["chatgpt"],
      );

      const start = await service.startOAuthWithPolling("chatgpt");
      assert.equal(start.provider, "chatgpt");
      assert.equal(start.authorizeUrl, "https://auth.openai.com/device");
      assert.equal(start.deviceCode?.userCode, "USER-CODE");
      assert.equal(start.deviceCode?.verificationUri, "https://auth.openai.com/device");
      assert.ok((start.deviceCode?.expiresAt ?? 0) > Date.now());
    });
  });
});

test("polling drives the device login to a persisted session", async () => {
  await withTempDir(async () => {
    await withHarness({ pendingPolls: 1 }, async ({ service, credentials, advance }) => {
      const start = await service.startOAuth("chatgpt");
      assert.ok(start.deviceCode);

      // The first poll is still pending and must not be reported as a result.
      assert.equal(await service.pollPendingOAuth(), null);
      advance(6_000);
      const result = await service.pollPendingOAuth();
      assert.equal(result?.kind, "session");
      if (result?.kind === "session") {
        assert.equal(result.provider, "chatgpt");
        assert.equal(result.userInfo.id, "acct-service");
        assert.equal(result.userInfo.displayName, "ChatGPT (pro)");
      }

      assert.equal(await service.getActiveProvider(), "chatgpt");
      // The account id lives inside the JWT payload, so decode rather than match.
      const storedAccessToken = credentials.dump().get("oauth:chatgpt:access_token") ?? "";
      const claims = JSON.parse(
        Buffer.from(storedAccessToken.split(".")[1] ?? "", "base64url").toString("utf-8"),
      ) as { chatgpt_account_id?: string };
      assert.equal(claims.chatgpt_account_id, "acct-service");
      assert.ok(credentials.dump().get("oauth:chatgpt:refresh_token"));
      // This provider issues no shared backend JWT, so none may be invented.
      assert.equal(credentials.dump().has("zcodejwttoken"), false);
    });
  });
});

test("a denied or expired device login surfaces as a login failure, not a silent hang", async () => {
  await withTempDir(async () => {
    const service = new OAuthService(createMemoryCredentialService(), {
      adapters: [
        new ChatGptOAuthAdapter({
          now: () => Date.now(),
          grantStorePath: join(tmpdir(), `zcode-chatgpt-denied-${process.pid}.json`),
          client: createChatGptClient({
            transport: async (url) =>
              url.endsWith("/oauth/device/code")
                ? new Response(
                    JSON.stringify({
                      device_code: "device-code",
                      user_code: "USER-CODE",
                      verification_uri: "https://auth.openai.com/device",
                      expires_in: 900,
                      interval: 5,
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } },
                  )
                : new Response(JSON.stringify({ error: "access_denied" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                  }),
          }),
        }),
      ],
      now: () => Date.now(),
    });
    try {
      await service.startOAuth("chatgpt");
      await assert.rejects(() => service.pollPendingOAuth(), /denied/);
      assert.equal(await service.getActiveProvider(), null);
    } finally {
      await service.cancelPending();
    }
  });
});

test("cancelling a device login stops it from completing later", async () => {
  await withTempDir(async () => {
    await withHarness({ pendingPolls: 5 }, async ({ service, credentials, advance }) => {
      await service.startOAuth("chatgpt");
      await service.cancelPending("chatgpt");

      advance(60_000);
      assert.equal(await service.pollPendingOAuth(), null);
      assert.equal(credentials.dump().has("oauth:chatgpt:access_token"), false);
      assert.equal(await service.getActiveProvider(), null);
    });
  });
});

test("a restored ChatGPT session does not require the shared backend JWT", async () => {
  await withTempDir(async () => {
    await withHarness({}, async ({ service, advance }) => {
      await service.startOAuth("chatgpt");
      await service.pollPendingOAuth();
      advance(6_000);
      await service.pollPendingOAuth();

      const restored = await service.restoreCachedSessionState();
      assert.equal(restored.status, "authenticated");
      if (restored.status === "authenticated") {
        assert.equal(restored.userInfo.id, "acct-service");
      }

      // An explicit sign-out must take the session down with it.
      await service.logout("chatgpt");
      assert.equal((await service.restoreCachedSessionState()).status, "signed-out");
    });
  });
});

test("logout clears both the shared session and the app-owned grant", async () => {
  await withTempDir(async () => {
    await withHarness({}, async ({ service, credentials, advance }) => {
      await service.startOAuth("chatgpt");
      await service.pollPendingOAuth();
      advance(6_000);
      await service.pollPendingOAuth();
      assert.equal(await service.getActiveProvider(), "chatgpt");

      await service.logout("chatgpt");
      assert.equal(await service.getActiveProvider(), null);
      assert.equal(credentials.dump().has("oauth:chatgpt:access_token"), false);
      assert.equal(credentials.dump().has("oauth:chatgpt:refresh_token"), false);
      assert.equal(credentials.dump().has("oauth:chatgpt:user_info"), false);
      assert.equal(credentials.dump().has("oauth:active_provider"), false);
    });
  });
});

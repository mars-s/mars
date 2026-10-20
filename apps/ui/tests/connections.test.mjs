import assert from "node:assert/strict";
import test from "node:test";
import { connectionChanges, parseConnections, updateConnections } from "../lib/pi/connections.ts";

const status = {
  discord: { configured: true, connected: false, guildId: "111111111111111111" },
  opencode: { configured: true },
};

test("status requires host confirmation and discards unexpected credential fields", () => {
  const result = parseConnections({
    ...status,
    discord: { ...status.discord, token: "fixture-secret" },
    opencode: { ...status.opencode, apiKey: "fixture-key" },
  });
  assert.equal(result.opencode.enabled, false);
  assert.equal(result.discord.connected, false);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  assert.ok(!JSON.stringify(result).includes("fixture-key"));
  assert.throws(() => parseConnections({ discord: { configured: "yes" } }), /unavailable/);
});

test("save retains blank keys, uses canonical OpenCode field and validates the server ID", () => {
  assert.deepEqual(
    connectionChanges({ discordToken: "", openCodeApiKey: " ", guildId: status.discord.guildId }),
    { guildId: status.discord.guildId },
  );
  assert.deepEqual(
    connectionChanges({
      discordToken: " fixture-token ",
      openCodeApiKey: " fixture-key ",
      guildId: status.discord.guildId,
    }),
    {
      guildId: status.discord.guildId,
      discordToken: "fixture-token",
      openCodeApiKey: "fixture-key",
    },
  );
  assert.throws(
    () => connectionChanges({ discordToken: "", openCodeApiKey: "", guildId: "invalid" }),
    /valid Discord server ID/,
  );
});

test("failed credential save never includes the server response in its error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("fixture-private-key", { status: 500 });
  try {
    await assert.rejects(
      updateConnections("save", { guildId: status.discord.guildId }),
      /Your entries are still here/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("connect is a separate explicit POST followed by canonical host status", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(status), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await updateConnections("connect");
    assert.equal(calls[0].url, "/api/connections/connect");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "{}");
    assert.equal(calls[1].url, "/api/connections");
    assert.equal(result.discord.connected, false);
  } finally {
    globalThis.fetch = original;
  }
});

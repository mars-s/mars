import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connections } from "./connections.mjs";

const dataDir = await mkdtemp(join(tmpdir(), "pi-connections-test-"));
const guild = "111111111111111111";
const otherGuild = "222222222222222222";
const channel = "333333333333333333";
const token = "test-discord-token-never-live";
const key = "test-opencode-key-never-live";
let requests = [];
let responseMode = "normal";
const fetcher = async (url, options) => {
  requests.push({ url, options });
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, "Bot " + token);
  const path = new URL(url).pathname;
  assert.equal(new URL(url).origin, "https://discord.com");
  if (responseMode === "network-error") throw Error(token + key);
  if (responseMode === "unauthorised")
    return { ok: false, status: 401, json: async () => ({ message: token }) };
  if (responseMode === "forbidden")
    return { ok: false, status: 403, json: async () => ({ message: key }) };
  if (responseMode === "ratelimit") return { ok: false, status: 429 };
  const values = {
    "/api/v10/users/@me": {
      id: "444444444444444444",
      username: token,
      bot: responseMode !== "user-token",
    },
    ["/api/v10/guilds/" + guild]: {
      id: responseMode === "wrong-guild" ? otherGuild : guild,
      name: "Test server",
    },
    ["/api/v10/guilds/" + guild + "/channels"]: [
      { id: channel, guild_id: guild, name: "general", type: 0 },
      { id: "555555555555555555", guild_id: otherGuild, name: "foreign", type: 0 },
    ],
    ["/api/v10/channels/" + channel]: {
      id: channel,
      guild_id: responseMode === "wrong-channel" ? otherGuild : guild,
    },
    ["/api/v10/channels/" + channel + "/messages"]: [
      {
        id: "666666666666666666",
        content: token + " " + key,
        author: { id: "777777777777777777", username: "Fixture" },
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
  };
  assert.ok(path in values, "Unexpected Discord URL");
  return { ok: true, status: 200, json: async () => values[path] };
};
try {
  const broker = new Connections({ dataDir, fetch: fetcher });
  await broker.boot();
  assert.equal(broker.status().discord.connected, false);
  await assert.rejects(broker.listDiscordChannels(), /Connect Discord/);
  await broker.save({ openCodeApiKey: key });
  const openCodeOnly = new Connections({ dataDir, fetch: fetcher });
  await openCodeOnly.boot();
  assert.equal(openCodeOnly.status().opencode.configured, true);
  assert.equal(openCodeOnly.status().discord.guildId, null);
  await broker.save({ guildId: guild, discordToken: token, openCodeApiKey: key });
  assert.equal(requests.length, 0, "Saving must not access live accounts");
  assert.equal((await stat(join(dataDir, "connections.json"))).mode & 0o777, 0o600);
  assert.equal(broker.getOpenCodeApiKey(), key);
  const visible = JSON.stringify(broker.status());
  assert.ok(!visible.includes(token) && !visible.includes(key));
  await broker.connectDiscord();
  assert.equal(requests.length, 2);
  assert.equal(broker.status().discord.connected, true);
  assert.equal(broker.status().discord.bot.username, "[redacted]");
  assert.equal((await broker.listDiscordChannels()).channels.length, 1);
  const messages = await broker.readDiscordMessages({ channelId: channel });
  assert.equal(messages.messages[0].content, "[redacted] [redacted]");
  assert.equal(requests.at(-1).url.endsWith("?limit=20"), true);
  let count = requests.length;
  await assert.rejects(broker.readDiscordMessages({ channelId: "../escape" }), /Invalid Discord/);
  await assert.rejects(
    broker.readDiscordMessages({ channelId: channel, limit: 101 }),
    /Invalid Discord/,
  );
  assert.equal(requests.length, count);
  responseMode = "wrong-channel";
  await assert.rejects(
    broker.readDiscordMessages({ channelId: channel }),
    /outside the authorised server/,
  );
  assert.equal(requests.length, count + 1, "Wrong guild must not fetch messages");
  responseMode = "normal";
  const restarted = new Connections({ dataDir, fetch: fetcher });
  count = requests.length;
  await restarted.boot();
  assert.equal(restarted.status().discord.connected, true);
  assert.equal(requests.length, count, "Restart must not access Discord");
  await broker.save({ discordToken: "", openCodeApiKey: "" });
  assert.equal(broker.status().discord.connected, true, "Blank masked form preserves state");
  await broker.save({ discordToken: "replacement-test-discord-token" });
  assert.equal(broker.status().discord.connected, false, "Replacing token revokes connection");
  await broker.save({ discordToken: token });
  await broker.connectDiscord();
  await broker.save({ guildId: otherGuild });
  assert.equal(broker.status().discord.connected, false, "Changing guild revokes connection");
  await broker.save({ guildId: guild });
  responseMode = "user-token";
  await assert.rejects(broker.connectDiscord(), /must belong to a bot/);
  responseMode = "wrong-guild";
  await assert.rejects(broker.connectDiscord(), /different server/);
  assert.equal(broker.status().discord.connected, false);
  responseMode = "network-error";
  await assert.rejects(
    broker.connectDiscord(),
    (error) => !error.message.includes(token) && !error.message.includes(key),
  );
  responseMode = "normal";
  await broker.connectDiscord();
  responseMode = "forbidden";
  await assert.rejects(broker.listDiscordChannels(), /access denied/);
  assert.equal(broker.status().discord.connected, false);
  responseMode = "unauthorised";
  await assert.rejects(broker.connectDiscord(), /authentication failed/);
  responseMode = "normal";
  await broker.connectDiscord();
  responseMode = "ratelimit";
  await assert.rejects(broker.listDiscordChannels(), /rate limit/);
  responseMode = "normal";
  await broker.disconnectDiscord();
  await assert.rejects(broker.readDiscordMessages({ channelId: channel }), /Connect Discord/);
  await Promise.all([broker.save({ discordToken: null }), broker.save({ openCodeApiKey: null })]);
  assert.equal(broker.status().discord.configured, false);
  assert.equal(broker.status().opencode.configured, false);
  assert.equal(broker.getOpenCodeApiKey(), undefined);
  const saved = JSON.parse(await readFile(join(dataDir, "connections.json"), "utf8"));
  assert.equal(saved.discordToken, null);
  assert.equal(saved.openCodeApiKey, null);
  const restricted = new Connections({
    dataDir: join(dataDir, "restricted"),
    fetch: fetcher,
    allowedGuildId: guild,
  });
  await restricted.boot();
  await assert.rejects(restricted.save({ guildId: otherGuild }), /outside the authorised scope/);
  await assert.rejects(restricted.save({ discordToken: "invalid\nvalue" }), /Invalid Discord/);
  await assert.rejects(restricted.save({ unknown: "field" }), /Unknown/);
  await writeFile(
    join(dataDir, "connections.json"),
    JSON.stringify({
      version: 1,
      guildId: guild,
      discordToken: token,
      openCodeApiKey: key,
      discord: { guild: { id: otherGuild }, bot: { id: "444444444444444444" } },
    }),
  );
  const malformed = new Connections({ dataDir, fetch: fetcher });
  await assert.rejects(malformed.boot(), /Cannot load/);
  console.log(
    "PASS: private credentials, explicit connection, scoped read-only Discord, redaction, permissions, restart and serialised saves (mock fetch only)",
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

import { mkdir, readFile, chmod, lstat, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ROOT } from "./security.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^[0-9]{17,20}$/;
const isSnowflake = (value) => typeof value === "string" && SNOWFLAKE.test(value);

export class Connections {
  #state = { version: 1, guildId: null, discordToken: null, openCodeApiKey: null, discord: null };
  #queue = Promise.resolve();
  #fetch;
  #path;
  #dataDir;
  #allowedGuild;
  constructor({
    dataDir = join(ROOT, "data"),
    fetch: fetcher = globalThis.fetch,
    allowedGuildId = null,
  } = {}) {
    if (allowedGuildId !== null && !isSnowflake(allowedGuildId))
      throw Error("Invalid authorised Discord server");
    this.#fetch = fetcher;
    this.#dataDir = dataDir;
    this.#path = join(dataDir, "connections.json");
    this.#allowedGuild = allowedGuildId;
    this.#state.guildId = allowedGuildId;
  }
  #serial(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }
  async boot() {
    return this.#serial(async () => {
      try {
        const info = await lstat(this.#path);
        if (!info.isFile() || info.isSymbolicLink())
          throw Error("Invalid private connection store");
        const stored = JSON.parse(await readFile(this.#path, "utf8"));
        if (
          stored.version !== 1 ||
          (stored.guildId !== null && !isSnowflake(stored.guildId)) ||
          (this.#allowedGuild && stored.guildId !== this.#allowedGuild)
        )
          throw Error("Invalid private connection store");
        for (const field of ["discordToken", "openCodeApiKey"])
          this.#validateSecret(stored[field], field);
        if (
          stored.discord &&
          (stored.discord.guild?.id !== stored.guildId || !isSnowflake(stored.discord.bot?.id))
        )
          throw Error("Invalid private connection store");
        this.#state = stored;
        await chmod(this.#path, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw Error("Cannot load private connection settings");
      }
      return this.status();
    });
  }
  #validateSecret(value, field) {
    if (value === null || value === undefined) return;
    if (typeof value !== "string" || value.length < 10 || value.length > 4096 || /\s/.test(value))
      throw Error(
        field === "discordToken" ? "Invalid Discord token format" : "Invalid OpenCode key format",
      );
  }
  async #persist(next) {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    const temporary = this.#path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#path);
      this.#state = next;
    } catch {
      await unlink(temporary).catch(() => {});
      throw Error("Could not save private connection settings");
    }
  }
  status() {
    const verified = this.#state.discord;
    return {
      discord: {
        configured: !!this.#state.discordToken,
        connected: !!verified && !!this.#state.discordToken,
        guildId: this.#state.guildId,
        bot: verified ? this.#clean(verified.bot) : null,
        guild: verified ? this.#clean(verified.guild) : null,
        verifiedAt: verified?.verifiedAt ?? null,
        mode: "read-only",
      },
      opencode: { configured: !!this.#state.openCodeApiKey, enabled: false },
    };
  }
  save(input) {
    return this.#serial(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("Invalid connection settings");
      if (
        Object.keys(input).some(
          (key) => !["discordToken", "openCodeApiKey", "guildId"].includes(key),
        )
      )
        throw Error("Unknown connection setting");
      if (
        input.guildId !== undefined &&
        (!isSnowflake(input.guildId) ||
          (this.#allowedGuild && input.guildId !== this.#allowedGuild))
      )
        throw Error("Discord server is outside the authorised scope");
      const next = structuredClone(this.#state);
      if (input.guildId !== undefined) next.guildId = input.guildId;
      for (const field of ["discordToken", "openCodeApiKey"]) {
        const value = input[field];
        if (value === undefined || value === "") continue;
        this.#validateSecret(value, field);
        next[field] = value;
      }
      if (next.discordToken !== this.#state.discordToken || next.guildId !== this.#state.guildId)
        next.discord = null;
      await this.#persist(next);
      return this.status();
    });
  }
  getOpenCodeApiKey() {
    return this.#state.openCodeApiKey ?? undefined;
  }
  /** The saved Discord bot token, for the gateway's Discord adapter only. Never returned over HTTP. */
  getDiscordToken() {
    return this.#state.discordToken ?? undefined;
  }
  #clean(value) {
    let text = JSON.stringify(value);
    for (const secret of [this.#state.discordToken, this.#state.openCodeApiKey]) {
      if (secret) text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
    }
    return JSON.parse(text);
  }
  async #get(path) {
    let response;
    try {
      response = await this.#fetch(DISCORD_API + path, {
        method: "GET",
        headers: {
          Authorization: "Bot " + this.#state.discordToken,
          Accept: "application/json",
          "User-Agent": "DiscordBot (https://github.com/mars-s/mars, 0.1.0)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw Error("Discord request could not be completed");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        if (this.#state.discord) await this.#persist({ ...this.#state, discord: null });
        throw Error(
          response.status === 401
            ? "Discord authentication failed; replace the bot token"
            : "Discord access denied; check bot membership and channel permissions",
        );
      }
      if (response.status === 429) throw Error("Discord rate limit reached; try again later");
      throw Error("Discord request failed");
    }
    try {
      return this.#clean(await response.json());
    } catch {
      throw Error("Discord returned an invalid response");
    }
  }
  connectDiscord() {
    return this.#serial(async () => {
      if (!this.#state.guildId) throw Error("Choose a Discord server in Settings first");
      if (!this.#state.discordToken) throw Error("Save a replacement Discord bot token first");
      // Invalidate before verification so a failed reconnect cannot retain old authority.
      await this.#persist({ ...this.#state, discord: null });
      const bot = await this.#get("/users/@me");
      if (bot.bot !== true || !isSnowflake(bot.id))
        throw Error("Discord credentials must belong to a bot");
      const guild = await this.#get("/guilds/" + this.#state.guildId);
      if (guild.id !== this.#state.guildId) throw Error("Discord returned a different server");
      await this.#persist({
        ...this.#state,
        discord: {
          bot: { id: bot.id, username: String(bot.username ?? "").slice(0, 100) },
          guild: { id: guild.id, name: String(guild.name ?? "").slice(0, 200) },
          verifiedAt: new Date().toISOString(),
        },
      });
      return this.status();
    });
  }
  disconnectDiscord() {
    return this.#serial(async () => {
      await this.#persist({ ...this.#state, discord: null });
      return this.status();
    });
  }
  #requireConnected() {
    if (!this.#state.discordToken || !this.#state.discord)
      throw Error("Connect Discord in Settings first");
  }
  listDiscordChannels() {
    return this.#serial(async () => {
      this.#requireConnected();
      const channels = await this.#get("/guilds/" + this.#state.guildId + "/channels");
      if (!Array.isArray(channels)) throw Error("Discord returned an invalid channel list");
      return this.#clean({
        guildId: this.#state.guildId,
        channels: channels
          .filter((channel) => channel.guild_id === this.#state.guildId && isSnowflake(channel.id))
          .map((channel) => ({
            id: channel.id,
            name: String(channel.name ?? "").slice(0, 100),
            type: channel.type,
          })),
      });
    });
  }
  readDiscordMessages({ channelId, limit = 20 } = {}) {
    return this.#serial(async () => {
      this.#requireConnected();
      if (
        typeof channelId !== "string" ||
        !isSnowflake(channelId) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw Error("Invalid Discord channel or message limit");
      const channel = await this.#get("/channels/" + channelId);
      if (channel.id !== channelId || channel.guild_id !== this.#state.guildId)
        throw Error("Discord channel is outside the authorised server");
      const messages = await this.#get("/channels/" + channelId + "/messages?limit=" + limit);
      if (!Array.isArray(messages)) throw Error("Discord returned an invalid message list");
      return this.#clean({
        guildId: this.#state.guildId,
        channelId,
        messages: messages.slice(0, limit).map((message) => ({
          id: message.id,
          content: String(message.content ?? "").slice(0, 20000),
          timestamp: message.timestamp,
          author: {
            id: message.author?.id,
            username: String(message.author?.username ?? "").slice(0, 100),
            bot: message.author?.bot === true,
          },
        })),
      });
    });
  }
}

export type ConnectionsStatus = {
  discord: {
    configured: boolean;
    connected: boolean;
    guildId: string;
    bot?: { id: string; username: string };
    error?: string;
  };
  opencode: { configured: boolean; enabled: boolean };
};

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function parseConnections(value: unknown): ConnectionsStatus {
  const source = object(value),
    discord = object(source.discord),
    opencode = object(source.opencode);
  if (
    typeof discord.configured !== "boolean" ||
    typeof discord.connected !== "boolean" ||
    (typeof discord.guildId !== "string" && discord.guildId !== null) ||
    typeof opencode.configured !== "boolean"
  )
    throw Error("Connection settings are unavailable. Try loading them again.");
  const bot = object(discord.bot);
  return {
    discord: {
      configured: discord.configured,
      connected: discord.connected,
      guildId: typeof discord.guildId === "string" ? discord.guildId : "",
      ...(typeof bot.id === "string" && typeof bot.username === "string"
        ? { bot: { id: bot.id, username: bot.username } }
        : {}),
      // Account errors are deliberately summarised here, never rendered from a
      // response body that could accidentally contain a credential.
      ...(discord.error
        ? {
            error:
              "Discord verification failed. Check the token and server access, then try again.",
          }
        : {}),
    },
    opencode: { configured: opencode.configured, enabled: opencode.enabled === true },
  };
}

export function connectionChanges(input: {
  discordToken: string;
  openCodeApiKey: string;
  guildId: string;
}) {
  const guildId = input.guildId.trim();
  if ((guildId || input.discordToken.trim()) && !/^\d{17,20}$/.test(guildId))
    throw Error("Enter a valid Discord server ID (17 to 20 digits).");
  return {
    ...(guildId ? {guildId} : {}),
    ...(input.discordToken.trim() ? { discordToken: input.discordToken.trim() } : {}),
    ...(input.openCodeApiKey.trim() ? { openCodeApiKey: input.openCodeApiKey.trim() } : {}),
  };
}

export async function loadConnections(signal?: AbortSignal): Promise<ConnectionsStatus> {
  const response = await fetch("/api/connections", { cache: "no-store", signal });
  if (!response.ok) throw Error("Could not load connection settings. Try again.");
  const value: unknown = await response.json();
  return parseConnections(value);
}

export async function updateConnections(
  action: "save" | "connect" | "disconnect",
  changes?: ReturnType<typeof connectionChanges>,
): Promise<ConnectionsStatus> {
  const path = action === "save" ? "/api/connections" : `/api/connections/${action}`;
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes ?? {}),
  });
  if (!response.ok)
    throw Error(
      action === "save"
        ? "Could not save your credentials. Your entries are still here. Try again."
        : action === "connect"
          ? "Could not verify Discord. Check the saved token and server access, then try again."
          : "Could not disconnect Discord. Try again.",
    );
  return loadConnections();
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  connectionChanges,
  loadConnections,
  updateConnections,
  type ConnectionsStatus,
} from "@/lib/pi/connections";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./connection-settings.css";

type Operation = "idle" | "save" | "connect" | "disconnect";

export function ConnectionSettings() {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [discordToken, setDiscordToken] = useState("");
  const [openCodeApiKey, setOpenCodeApiKey] = useState("");
  const [guildId, setGuildId] = useState("");
  const [operation, setOperation] = useState<Operation>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const busy = operation !== "idle";

  useEffect(() => {
    const controller = new AbortController();
    loadConnections(controller.signal)
      .then((next) => {
        setStatus(next);
        setGuildId(next.discord.guildId);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load connection settings. Try again.",
          );
      });
    return () => controller.abort();
  }, [reload]);

  async function perform(action: Exclude<Operation, "idle">) {
    setError("");
    setNotice("");
    setOperation(action);
    try {
      const changes =
        action === "save"
          ? connectionChanges({ discordToken, openCodeApiKey, guildId })
          : undefined;
      const next = await updateConnections(action, changes);
      setStatus(next);
      if (action === "save") {
        setDiscordToken("");
        setOpenCodeApiKey("");
        setNotice(
          "Credentials saved on the Pi host. Connect Discord when you are ready to verify access.",
        );
      } else if (action === "connect") {
        setNotice(
          next.discord.connected
            ? "Discord identity and server access verified."
            : "Discord is not connected. Check the saved token and server access.",
        );
      } else setNotice("Discord disconnected. Saved credentials are retained.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The connection could not be updated. Try again.",
      );
    } finally {
      setOperation("idle");
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform("save");
  }

  return (
    <div className="connection-settings" aria-busy={busy}>
      <div className="connection-settings-intro">
        <h2>Connected apps</h2>
        <p>
          Credentials stay on the Pi host and are never added to the conversation. Use fresh keys if you
          have shared them in chat.
        </p>
      </div>
      {error && (
        <p className="connection-settings-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <div className="connection-settings-loading">
          {!error ? (
            <p role="status">Loading connection settings…</p>
          ) : (
            <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={save} autoComplete="off">
          <section aria-labelledby="discord-connection-heading">
            <div className="connection-settings-heading">
              <h3 id="discord-connection-heading">Discord</h3>
              <span>
                {status.discord.connected
                  ? "Connected"
                  : status.discord.configured
                    ? "Token saved"
                    : "Not configured"}
              </span>
            </div>
            {status.discord.connected && status.discord.bot && (
              <p>Connected as {status.discord.bot.username}.</p>
            )}
            <label htmlFor="discord-bot-token">Bot token</label>
            <Input
              id="discord-bot-token"
              name="discord-bot-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              disabled={busy}
              value={discordToken}
              placeholder={
                status.discord.configured
                  ? "Leave blank to keep the saved token"
                  : "Paste your new bot token"
              }
              onChange={(event) => setDiscordToken(event.target.value)}
              aria-describedby="discord-token-help"
            />
            <p id="discord-token-help" className="connection-settings-help">
              Saving a token does not connect the bot.
            </p>
            <label htmlFor="discord-server-id">Server ID</label>
            <Input
              id="discord-server-id"
              name="discord-server-id"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={guildId}
              onChange={(event) => setGuildId(event.target.value)}
              aria-describedby="discord-connect-help"
            />
            <p id="discord-connect-help" className="connection-settings-help">
              Connect checks the bot identity and access to this server. It does not send messages
              or start automatic replies.
            </p>
            {status.discord.error && (
              <p className="connection-settings-error" role="status">
                {status.discord.error}
              </p>
            )}
            <div className="connection-settings-actions">
              {status.discord.connected ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform("disconnect")}
                >
                  {operation === "disconnect" ? "Disconnecting…" : "Disconnect Discord"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    busy ||
                    !status.discord.configured ||
                    guildId.trim() !== status.discord.guildId ||
                    !!discordToken.trim()
                  }
                  onClick={() => void perform("connect")}
                >
                  {operation === "connect" ? "Checking Discord…" : "Connect Discord"}
                </Button>
              )}
            </div>
          </section>
          <section aria-labelledby="opencode-connection-heading">
            <div className="connection-settings-heading">
              <h3 id="opencode-connection-heading">OpenCode</h3>
              <span>
                {status.opencode.enabled
                  ? "Enabled"
                  : status.opencode.configured
                    ? "Key saved"
                    : "Not configured"}
              </span>
            </div>
            <label htmlFor="opencode-api-key">API key</label>
            <Input
              id="opencode-api-key"
              name="opencode-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              disabled={busy}
              value={openCodeApiKey}
              placeholder={
                status.opencode.configured
                  ? "Leave blank to keep the saved key"
                  : "Paste your new API key"
              }
              onChange={(event) => setOpenCodeApiKey(event.target.value)}
              aria-describedby="opencode-key-help"
            />
            <p id="opencode-key-help" className="connection-settings-help">
              {status.opencode.enabled
                ? "The host has enabled this provider."
                : "The key can be saved here. Provider integration is not enabled yet."}
            </p>
          </section>
          <div className="connection-settings-save">
            <Button type="submit" disabled={busy}>
              {operation === "save" ? "Saving…" : "Save credentials"}
            </Button>
          </div>
        </form>
      )}
      {notice && (
        <p className="connection-settings-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChannelMark } from "@/components/shell/channel-mark";
import {
  DECISION_LABELS,
  channelName,
  chatLabel,
  decidePairing,
  loadGateway,
  removeSender,
  unbindChat,
  type GatewaySender,
  type GatewayStatus,
} from "@/lib/pi/gateway";
import "./connection-settings.css";
import "./gateway-settings.css";

const STATE_LABELS = { running: "Running", starting: "Starting", failed: "Restarting after an error", stopped: "Off" } as const;
const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const ownerSetting = (channel: string) => `MARS_${channel.toUpperCase()}_OWNER`;
function senderNote({ channel, approved, configured }: GatewaySender) {
  if (!configured) return "Approved";
  if (approved) return `Approved, and set on the host (${ownerSetting(channel)})`;
  return `Set on the host (${ownerSetting(channel)}). To remove it, take it out there and restart Mars.`;
}

/** Settings, Gateway: chat apps that reach Mars, linked chats, pairing requests and recent activity. */
export function GatewaySettings({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadGateway(controller.signal)
        .then((next) => { setStatus(next); setError(""); })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the gateway."); });
    void load();
    const timer = setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload]);

  const act = useCallback(async (key: string, work: () => Promise<GatewayStatus>) => {
    setBusy(key);
    setError("");
    try { setStatus(await work()); } catch (cause) { setError(cause instanceof Error ? cause.message : "That did not work. Try again."); } finally { setBusy(""); }
  }, []);

  return (
    <div className="connection-settings gateway-settings" aria-busy={!!busy}>
      <p className="connection-settings-intro">
        Talk to Mars from other apps. Each chat continues one conversation, which you can also open here. Commands
        in any chat: /new, /sessions, /switch, /status, /stop, /help.
      </p>
      {error && <p className="connection-settings-error" role="alert">{error}</p>}
      {!status ? (
        <div className="connection-settings-loading">
          {!error ? <p role="status">Loading the gateway…</p> : <Button variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        </div>
      ) : (
        <>
          {status.pairings.length > 0 && (
            <section aria-labelledby="gateway-pairings-heading" className="gateway-pairings">
              <div className="connection-settings-heading">
                <h3 id="gateway-pairings-heading">Waiting for approval</h3>
                <span>{status.pairings.length}</span>
              </div>
              <p className="connection-settings-help">
                Approving lets this sender use Mars with the same power as you, including running commands on this
                computer. Only approve your own accounts.
              </p>
              <ul className="gateway-list">
                {status.pairings.map((pairing) => (
                  <li key={pairing.code} className="gateway-row">
                    <ChannelMark channel={pairing.channel} />
                    <div className="gateway-row-text">
                      <strong>{pairing.name || pairing.sender}</strong>
                      <span>{channelName(pairing.channel)} sender {pairing.sender}, code <code>{pairing.code}</code></span>
                    </div>
                    <div className="gateway-row-actions">
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act("reject" + pairing.code, () => decidePairing(pairing.code, false))}>
                        Reject
                      </Button>
                      <Button size="sm" disabled={!!busy} onClick={() => void act("approve" + pairing.code, () => decidePairing(pairing.code, true))}>
                        {busy === "approve" + pairing.code ? "Approving…" : "Approve"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="gateway-apps-heading">
            <div className="connection-settings-heading">
              <h3 id="gateway-apps-heading">Chat apps</h3>
              {status.outbox > 0 && <span>{status.outbox} replies waiting to send</span>}
            </div>
            <ul className="gateway-list">
              {status.adapters.map((adapter) => (
                <li key={adapter.channel} className="gateway-row">
                  <ChannelMark channel={adapter.channel} />
                  <div className="gateway-row-text">
                    <strong>{channelName(adapter.channel)}</strong>
                    <span className={adapter.state === "failed" ? "gateway-row-detail" : undefined}>
                      {adapter.detail || (adapter.channel === "api" ? "POST /api/gateway/api/messages with your owner token" : "")}
                    </span>
                  </div>
                  <span className="gateway-state" data-state={adapter.state}>{STATE_LABELS[adapter.state]}</span>
                </li>
              ))}
            </ul>
            {!status.adapters.some((a) => a.channel === "telegram" || a.channel === "discord") && (
              <p className="connection-settings-help">
                Telegram and Discord are off. To turn one on, set its token and your own account id on the host
                (MARS_GATEWAY_TELEGRAM=1 with MARS_TELEGRAM_TOKEN and MARS_TELEGRAM_OWNER, or MARS_GATEWAY_DISCORD=1),
                then restart Mars. docs/GATEWAY.md has the steps.
              </p>
            )}
          </section>
          <section aria-labelledby="gateway-chats-heading">
            <div className="connection-settings-heading">
              <h3 id="gateway-chats-heading">Linked chats</h3>
              <span>{status.bindings.length || "None yet"}</span>
            </div>
            {status.bindings.length === 0 ? (
              <p className="connection-settings-help">A chat links to a conversation the first time you message Mars from it.</p>
            ) : (
              <ul className="gateway-list">
                {status.bindings.map((binding) => (
                  <li key={binding.route} className="gateway-row">
                    <ChannelMark channel={binding.channel} />
                    <div className="gateway-row-text">
                      {onOpenConversation ? (
                        <button type="button" className="gateway-link" onClick={() => onOpenConversation(binding.conversationId)}>{binding.title}</button>
                      ) : (
                        <strong>{binding.title}</strong>
                      )}
                      <span>{channelName(binding.channel)}, {chatLabel(binding.route)}</span>
                    </div>
                    <Button size="sm" variant="ghost" disabled={!!busy} aria-label={`Unlink ${chatLabel(binding.route)} from ${binding.title}`}
                      onClick={() => void act("unbind" + binding.route, () => unbindChat(binding.route))}>
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <SendersSection senders={status.senders.filter((row) => row.channel !== "api")} busy={busy} act={act} />
          <section aria-labelledby="gateway-activity-heading">
            <div className="connection-settings-heading">
              <h3 id="gateway-activity-heading">Recent activity</h3>
              <span>Message text is not kept here</span>
            </div>
            {status.audit.length === 0 ? (
              <p className="connection-settings-help">Nothing yet.</p>
            ) : (
              <ol className="gateway-audit">
                {status.audit.slice(0, 12).map((row, index) => (
                  <li key={`${row.at}-${index}`} data-decision={row.decision}>
                    <time dateTime={row.at}>{time(row.at)}</time>
                    <span>{channelName(row.channel)}</span>
                    <span>{DECISION_LABELS[row.decision] ?? row.decision}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Who may use Mars from a chat app, with Remove for the approved ones. */
function SendersSection({ senders, busy, act }: { senders: GatewaySender[]; busy: string; act: (key: string, work: () => Promise<GatewayStatus>) => Promise<void> }) {
  return (
    <section aria-labelledby="gateway-senders-heading">
      <div className="connection-settings-heading">
        <h3 id="gateway-senders-heading">Allowed senders</h3>
        <span>{senders.length || "None yet"}</span>
      </div>
      <p className="connection-settings-help">
        Each of these can use Mars with the same power as you. After you remove a sender, their messages get a new
        pairing code that only you can approve.
      </p>
      {senders.length > 0 && (
        <ul className="gateway-list">
          {senders.map((row) => (
            <li key={row.channel + ":" + row.sender} className="gateway-row">
              <ChannelMark channel={row.channel} />
              <div className="gateway-row-text">
                <strong>{channelName(row.channel)} sender {row.sender}</strong>
                <span>{senderNote(row)}</span>
              </div>
              {row.approved && (
                <Button size="sm" variant="ghost" disabled={!!busy} aria-label={`Remove ${channelName(row.channel)} sender ${row.sender}`}
                  onClick={() => void act("remove" + row.channel + ":" + row.sender, () => removeSender(row.channel, row.sender))}>
                  {busy === "remove" + row.channel + ":" + row.sender ? "Removing…" : "Remove"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Gateway status for Settings (docs/GATEWAY.md). Parsed at the boundary: the UI renders
// only these fields, never raw response text.
export type GatewayAdapter = { channel: string; state: "running" | "starting" | "failed" | "stopped"; detail: string; failures: number };
export type GatewayBinding = { route: string; channel: string; conversationId: string; title: string };
export type GatewayPairing = { code: string; channel: string; sender: string; name: string; expiresAt: string };
/**
 * A sender allowed to use Mars. `approved`: on the approved list, so Remove takes it off.
 * `configured`: named in the host configuration (MARS_TELEGRAM_OWNER and the like), so it
 * stays allowed until it is taken out there and Mars restarts.
 */
export type GatewaySender = { channel: string; sender: string; approved: boolean; configured: boolean };
export type GatewayAudit = { at: string; channel: string; decision: string; route?: string; conversationId?: string };
export type GatewayStatus = {
  adapters: GatewayAdapter[];
  bindings: GatewayBinding[];
  pairings: GatewayPairing[];
  senders: GatewaySender[];
  audit: GatewayAudit[];
  outbox: number;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const STATES = ["running", "starting", "failed", "stopped"] as const;
const SENDER_LIMIT = 200;

/** `{ telegram: ["1", "2"] }` as [channel, sender] pairs, bounded. */
function senderPairs(value: unknown): [string, string][] {
  return Object.entries(record(value)).flatMap(([channel, ids]) =>
    Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id).map((id): [string, string] => [text(channel, 40), text(id, 64)]) : [],
  );
}

/** Approved and configured senders merged into one row each, configured first. */
function parseSenders(allowed: unknown, owners: unknown): GatewaySender[] {
  const rows = new Map<string, GatewaySender>();
  for (const [channel, sender] of senderPairs(owners)) rows.set(channel + ":" + sender, { channel, sender, approved: false, configured: true });
  for (const [channel, sender] of senderPairs(allowed)) {
    const row = rows.get(channel + ":" + sender);
    if (row) row.approved = true;
    else rows.set(channel + ":" + sender, { channel, sender, approved: true, configured: false });
  }
  return [...rows.values()].slice(0, SENDER_LIMIT);
}

export function parseGateway(value: unknown): GatewayStatus {
  const source = record(value);
  if (!Array.isArray(source.adapters)) throw Error("Gateway status is unavailable. Try again.");
  return {
    adapters: list(source.adapters).map((row) => ({
      channel: text(row.channel, 40),
      state: (STATES as readonly unknown[]).includes(row.state) ? (row.state as GatewayAdapter["state"]) : "stopped",
      detail: text(row.detail, 300),
      failures: Number.isInteger(row.failures) ? Number(row.failures) : 0,
    })),
    bindings: list(source.bindings).map((row) => ({
      route: text(row.route, 300), channel: text(row.channel, 40), conversationId: text(row.conversationId, 40), title: text(row.title, 160),
    })),
    pairings: list(source.pairings).map((row) => ({
      code: text(row.code, 16), channel: text(row.channel, 40), sender: text(row.sender, 64), name: text(row.name, 80), expiresAt: text(row.expiresAt, 40),
    })),
    senders: parseSenders(source.allowed, source.owners),
    audit: list(source.audit).slice(0, 50).map((row) => ({
      at: text(row.at, 40), channel: text(row.channel, 40), decision: text(row.decision, 40),
      ...(row.route ? { route: text(row.route, 300) } : {}), ...(row.conversationId ? { conversationId: text(row.conversationId, 40) } : {}),
    })),
    outbox: Number.isInteger(source.outbox) ? Number(source.outbox) : 0,
  };
}

export async function loadGateway(signal?: AbortSignal): Promise<GatewayStatus> {
  const response = await fetch("/api/gateway", { cache: "no-store", signal });
  if (!response.ok) throw Error("Could not load the gateway. Try again.");
  return parseGateway(await response.json());
}

export async function decidePairing(code: string, approve: boolean): Promise<GatewayStatus> {
  const response = await fetch("/api/gateway/pairings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, approve }),
  });
  if (!response.ok) throw Error(response.status === 404 ? "That code has expired. Ask them to message Mars again for a new one." : "Could not update the pairing. Try again.");
  return loadGateway();
}

export async function unbindChat(route: string): Promise<GatewayStatus> {
  const response = await fetch("/api/gateway/bindings/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route }),
  });
  if (!response.ok) throw Error("Could not unlink that chat. Try again.");
  return loadGateway();
}

/** Take a sender off the approved list. One named in the host configuration stays allowed. */
export async function removeSender(channel: string, sender: string): Promise<GatewayStatus> {
  const response = await fetch("/api/gateway/allow/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, sender }),
  });
  if (!response.ok) throw Error("Could not remove that sender. Try again.");
  return loadGateway();
}

export const CHANNEL_NAMES: Record<string, string> = { telegram: "Telegram", discord: "Discord", api: "HTTP API" };
export const channelName = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
/** "telegram:999:dm:5550001" -> "Direct message 5550001" */
export function chatLabel(route: string) {
  const [, , type, chat, , thread] = route.split(":");
  const base = type === "dm" ? `Direct message ${chat}` : `Group ${chat}`;
  return thread ? `${base}, thread ${thread}` : base;
}
export const DECISION_LABELS: Record<string, string> = {
  accepted: "Message sent to Mars",
  duplicate: "Repeat ignored",
  command: "Command",
  edited: "Edit ignored",
  denied: "Unknown sender, code sent",
  paired: "Sender approved",
  pairing_rejected: "Pairing rejected",
  removed: "Sender removed",
  not_ready: "No model connected",
  delivery_failed: "Reply could not be sent",
  delivery_retry: "Reply retried",
  adapter_failed: "Connection failed, restarting",
};

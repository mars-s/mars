// Connectors for Settings (docs/CONNECTORS.md). Parsed at the boundary: the UI renders only
// these fields. Keys go to the host once and are never read back; the host returns only
// whether one is saved.
export type ConnectorStatus = "connected" | "not_connected" | "needs_auth" | "error";
export type AuthType = "none" | "key" | "oauth";
export type Connector = {
  id: string;
  name: string;
  kind: "mcp" | "http";
  transport: "http" | "stdio";
  address: string;
  authType: AuthType;
  status: ConnectorStatus;
  lastError: string;
  toolCount: number;
  hasKey: boolean;
  signedIn: boolean;
};
export type BuiltInConnector = { id: string; name: string; status: string; detail: string };
export type ConnectorsState = { connectors: Connector[]; builtIn: BuiltInConnector[]; redirectUri: string };
export type ConnectResult = { connector: Connector; authorizationUrl?: string };
export type NewConnector = {
  name: string;
  kind: "mcp" | "http";
  url?: string;
  command?: string;
  auth: { type: AuthType; header?: string; env?: string; clientId?: string };
  key?: string;
  allowPrivateNetwork?: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const STATUSES: readonly ConnectorStatus[] = ["connected", "not_connected", "needs_auth", "error"];
const AUTH: readonly AuthType[] = ["none", "key", "oauth"];

export function parseConnector(value: unknown): Connector {
  const row = record(value);
  const auth = record(row.auth);
  const args = Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === "string") : [];
  return {
    id: text(row.id, 40),
    name: text(row.name, 80),
    kind: row.kind === "http" ? "http" : "mcp",
    transport: row.transport === "stdio" ? "stdio" : "http",
    address: row.transport === "stdio" ? [text(row.command, 300), ...args].join(" ").slice(0, 400) : text(row.url, 400),
    authType: (AUTH as readonly unknown[]).includes(auth.type) ? (auth.type as AuthType) : "none",
    status: (STATUSES as readonly unknown[]).includes(row.status) ? (row.status as ConnectorStatus) : "error",
    lastError: text(row.lastError, 300),
    toolCount: Number.isInteger(row.toolCount) ? Number(row.toolCount) : 0,
    hasKey: row.hasKey === true,
    signedIn: row.signedIn === true,
  };
}

export function parseConnectors(value: unknown): ConnectorsState {
  const source = record(value);
  if (!Array.isArray(source.connectors)) throw Error("Connectors are unavailable. Try again.");
  return {
    connectors: source.connectors.map(parseConnector).filter((row) => row.id),
    builtIn: (Array.isArray(source.builtIn) ? source.builtIn : []).map(record).map((row) => ({
      id: text(row.id, 40),
      name: text(row.name, 80),
      status: text(row.status, 40),
      detail: text(row.detail, 300),
    })),
    redirectUri: text(source.redirectUri, 400),
  };
}

async function failure(response: Response, fallback: string): Promise<Error> {
  try {
    const message = text(record(await response.json()).error, 300);
    return Error(message || fallback);
  } catch {
    return Error(fallback);
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, "That did not work. Try again.");
  return response.json();
}

export async function loadConnectors(signal?: AbortSignal): Promise<ConnectorsState> {
  const response = await fetch("/api/connectors", { cache: "no-store", signal });
  if (!response.ok) throw await failure(response, "Could not load connectors. Try again.");
  return parseConnectors(await response.json());
}

export async function addConnector(input: NewConnector): Promise<Connector> {
  return parseConnector(record(await post("/api/connectors", input)).connector);
}

function connectResult(value: unknown): ConnectResult {
  const source = record(value);
  const url = text(source.authorizationUrl, 4000);
  return { connector: parseConnector(source.connector), ...(/^https?:\/\//.test(url) ? { authorizationUrl: url } : {}) };
}

export async function connectConnector(id: string, key?: string): Promise<ConnectResult> {
  return connectResult(await post(`/api/connectors/${encodeURIComponent(id)}/connect`, key ? { key } : {}));
}

export async function refreshConnector(id: string): Promise<ConnectResult> {
  return connectResult(await post(`/api/connectors/${encodeURIComponent(id)}/refresh`, {}));
}

export async function removeConnector(id: string): Promise<void> {
  await post(`/api/connectors/${encodeURIComponent(id)}/remove`, {});
}

export const STATUS_LABELS: Record<string, string> = {
  connected: "Connected",
  not_connected: "Not connected",
  needs_auth: "Needs sign-in",
  error: "Error",
  available: "Available",
  not_set_up: "Not set up",
};

export function describeConnector(row: Connector): string {
  const kind = row.kind === "http" ? "HTTP API" : row.transport === "stdio" ? "Local MCP command" : "MCP server";
  const tools = row.kind === "mcp" && row.status === "connected" ? `, ${row.toolCount} ${row.toolCount === 1 ? "tool" : "tools"}` : "";
  const auth = row.authType === "oauth" ? ", OAuth" : row.authType === "key" ? (row.hasKey ? ", key saved" : ", no key yet") : "";
  return kind + tools + auth;
}

"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  STATUS_LABELS,
  addConnector,
  connectConnector,
  describeConnector,
  loadConnectors,
  refreshConnector,
  removeConnector,
  type AuthType,
  type ConnectResult,
  type Connector,
  type ConnectorsState,
  type NewConnector,
} from "@/lib/pi/connectors";
import "./connection-settings.css";
import "./connector-settings.css";

type Source = "url" | "command" | "http";
const SOURCES: { id: Source; label: string; field: string; placeholder: string }[] = [
  { id: "url", label: "MCP server (URL)", field: "Server URL", placeholder: "https://mcp.example.com/mcp" },
  { id: "command", label: "Local MCP command", field: "Command", placeholder: "npx -y @modelcontextprotocol/server-everything" },
  { id: "http", label: "HTTP API", field: "Base URL", placeholder: "https://api.example.com/v1" },
];
const AUTH_LABELS: Record<AuthType, string> = { none: "None", key: "API key or token", oauth: "OAuth sign-in" };

/** Open a blank tab while the click still counts as a user gesture, so the sign-in link is not blocked. */
function blankTab(): Window | null {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}
function follow(tab: Window | null, result: ConnectResult) {
  if (tab && result.authorizationUrl) tab.location.href = result.authorizationUrl;
  else tab?.close();
}

/** Settings, Connectors: built-in connections, the owner's connectors and the Add connector form. */
export function ConnectorSettings() {
  const [state, setState] = useState<ConnectorsState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("url");
  const [address, setAddress] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [key, setKey] = useState("");
  const [header, setHeader] = useState("");
  const [clientId, setClientId] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const waiting = Object.keys(links).length > 0;

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadConnectors(controller.signal)
        .then((next) => {
          setState(next);
          setError("");
          setLinks((current) => {
            const open = Object.fromEntries(Object.entries(current).filter(([id]) => next.connectors.find((row) => row.id === id)?.status === "needs_auth"));
            return Object.keys(open).length === Object.keys(current).length ? current : open;
          });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load connectors.");
        });
    void load();
    // While a sign-in tab is open, look for the connector turning connected.
    const timer = waiting ? setInterval(load, 3000) : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [reload, waiting]);

  const act = useCallback(async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const message = await work();
      if (message) setNotice(message);
      setReload((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work. Try again.");
    } finally {
      setBusy("");
    }
  }, []);

  const settle = (result: ConnectResult) => {
    const row = result.connector;
    if (result.authorizationUrl) {
      setLinks((current) => ({ ...current, [row.id]: result.authorizationUrl as string }));
      return `Sign in to ${row.name} in the new tab. This list updates when you are done.`;
    }
    return row.status === "connected" ? `${row.name} is connected.` : `${row.name} did not connect${row.lastError ? ": " + row.lastError : "."}`;
  };

  function connect(row: Connector) {
    const tab = row.authType === "oauth" ? blankTab() : null;
    const replacement = keys[row.id]?.trim();
    void act("connect" + row.id, async () => {
      try {
        const result = await connectConnector(row.id, replacement || undefined);
        follow(tab, result);
        setKeys((current) => ({ ...current, [row.id]: "" }));
        return settle(result);
      } catch (cause) {
        tab?.close();
        throw cause;
      }
    });
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const auth: NewConnector["auth"] = { type: authType };
    if (authType === "key" && header.trim()) auth[source === "command" ? "env" : "header"] = header.trim();
    if (authType === "oauth" && clientId.trim()) auth.clientId = clientId.trim();
    const input: NewConnector = {
      name: name.trim(),
      kind: source === "http" ? "http" : "mcp",
      ...(source === "command" ? { command: address.trim() } : { url: address.trim() }),
      auth,
      ...(authType === "key" && key ? { key } : {}),
      ...(allowPrivate && source !== "command" ? { allowPrivateNetwork: true } : {}),
    };
    const tab = authType === "oauth" ? blankTab() : null;
    void act("add", async () => {
      try {
        const created = await addConnector(input);
        setKey("");
        setName("");
        setAddress("");
        setHeader("");
        setClientId("");
        setAllowPrivate(false);
        const result = await connectConnector(created.id);
        follow(tab, result);
        return settle(result);
      } catch (cause) {
        tab?.close();
        throw cause;
      }
    });
  }

  const sourceInfo = SOURCES.find((item) => item.id === source) ?? SOURCES[0];
  const authChoices: AuthType[] = source === "command" ? ["none", "key"] : ["none", "key", "oauth"];

  return (
    <div className="connection-settings connector-settings" aria-busy={!!busy}>
      <p className="connection-settings-intro">
        Connect outside services so Mars can use them: MCP servers by URL or as a local command, and plain HTTP APIs.
        Keys and sign-ins stay on the Pi host; the agent never sees them.
      </p>
      {error && (
        <p className="connection-settings-error" role="alert">
          {error}
        </p>
      )}
      {!state ? (
        <div className="connection-settings-loading">
          {!error ? (
            <p role="status">Loading connectors…</p>
          ) : (
            <Button variant="outline" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <>
          <section aria-labelledby="connectors-heading">
            <div className="connection-settings-heading">
              <h3 id="connectors-heading">Your connectors</h3>
              <span>{state.connectors.length || "None yet"}</span>
            </div>
            {state.connectors.length === 0 ? (
              <p className="connection-settings-help">Add one below. Its tools appear in Extensions, where you can switch each one off.</p>
            ) : (
              <ul className="connector-list">
                {state.connectors.map((row) => (
                  <li key={row.id} className="connector-row" data-status={row.status}>
                    <div className="connector-row-main">
                      <div className="connector-row-text">
                        <strong>{row.name}</strong>
                        <span>{describeConnector(row)}</span>
                        <span className="connector-row-address" title={row.address}>
                          {row.address}
                        </span>
                      </div>
                      <span className="connector-state" data-status={row.status}>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </div>
                    {row.lastError && <p className="connector-row-error">{row.lastError}</p>}
                    {links[row.id] && (
                      <p className="connector-row-link">
                        <a href={links[row.id]} target="_blank" rel="noopener noreferrer">
                          Open the {row.name} sign-in
                        </a>
                      </p>
                    )}
                    {row.authType === "key" && (row.status === "needs_auth" || !row.hasKey) && (
                      <div className="connector-row-key">
                        <label htmlFor={`connector-key-${row.id}`}>{row.hasKey ? "Replacement key" : "Key"}</label>
                        <Input
                          id={`connector-key-${row.id}`}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          autoCapitalize="none"
                          value={keys[row.id] ?? ""}
                          disabled={!!busy}
                          placeholder="Paste the key, then Connect"
                          onChange={(event) => setKeys((current) => ({ ...current, [row.id]: event.target.value }))}
                        />
                      </div>
                    )}
                    <div className="connector-row-actions">
                      <Button size="sm" variant={row.status === "connected" ? "outline" : "default"} disabled={!!busy} onClick={() => connect(row)}>
                        {busy === "connect" + row.id ? "Connecting…" : row.status === "connected" || row.signedIn || row.hasKey ? "Reconnect" : "Connect"}
                      </Button>
                      {row.kind === "mcp" && row.status === "connected" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!busy}
                          onClick={() => void act("refresh" + row.id, async () => settle(await refreshConnector(row.id)))}
                        >
                          {busy === "refresh" + row.id ? "Refreshing…" : "Refresh tools"}
                        </Button>
                      )}
                      {confirming === row.id ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!!busy}
                          onClick={() =>
                            void act("remove" + row.id, async () => {
                              await removeConnector(row.id);
                              setConfirming("");
                              return `${row.name} removed, with its tools and saved credentials.`;
                            })
                          }
                        >
                          {busy === "remove" + row.id ? "Removing…" : `Remove ${row.name}`}
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirming(row.id)} aria-label={`Remove ${row.name}`}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="connectors-builtin-heading">
            <div className="connection-settings-heading">
              <h3 id="connectors-builtin-heading">Built in</h3>
              <span>Managed in Settings, Apps</span>
            </div>
            <ul className="connector-list">
              {state.builtIn.map((row) => (
                <li key={row.id} className="connector-row" data-status={row.status}>
                  <div className="connector-row-main">
                    <div className="connector-row-text">
                      <strong>{row.name}</strong>
                      <span className="connector-row-detail">{row.detail}</span>
                    </div>
                    <span className="connector-state" data-status={row.status}>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="connectors-add-heading">
            <div className="connection-settings-heading">
              <h3 id="connectors-add-heading">Add connector</h3>
            </div>
            <form onSubmit={add} autoComplete="off" className="connector-form">
              <label htmlFor="connector-name">Name</label>
              <Input id="connector-name" value={name} maxLength={60} required disabled={!!busy} placeholder="Linear" onChange={(event) => setName(event.target.value)} />
              <label htmlFor="connector-source">Type</label>
              <select
                id="connector-source"
                className="connector-select"
                value={source}
                disabled={!!busy}
                onChange={(event) => {
                  const next = event.target.value as Source;
                  setSource(next);
                  if (next === "command" && authType === "oauth") setAuthType("none");
                }}
              >
                {SOURCES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <label htmlFor="connector-address">{sourceInfo.field}</label>
              <Input
                id="connector-address"
                value={address}
                required
                spellCheck={false}
                autoCapitalize="none"
                disabled={!!busy}
                placeholder={sourceInfo.placeholder}
                onChange={(event) => setAddress(event.target.value)}
                aria-describedby="connector-address-help"
              />
              <p id="connector-address-help" className="connection-settings-help">
                {source === "command"
                  ? "Runs on the host in the workspace folder, with only a basic environment."
                  : "Use https:// for anything not on this machine."}
              </p>
              {source !== "command" && (
                <label className="connector-check">
                  <input type="checkbox" checked={allowPrivate} disabled={!!busy} onChange={(event) => setAllowPrivate(event.target.checked)} />
                  Allow an address on my home network or tailnet
                </label>
              )}
              <label htmlFor="connector-auth">Sign-in</label>
              <select id="connector-auth" className="connector-select" value={authType} disabled={!!busy} onChange={(event) => setAuthType(event.target.value as AuthType)}>
                {authChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {AUTH_LABELS[choice]}
                  </option>
                ))}
              </select>
              {authType === "key" && (
                <>
                  <label htmlFor="connector-key">Key</label>
                  <Input
                    id="connector-key"
                    type="password"
                    value={key}
                    required
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={!!busy}
                    placeholder="Paste the API key or token"
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <label htmlFor="connector-header">{source === "command" ? "Environment variable" : "Header name"}</label>
                  <Input
                    id="connector-header"
                    value={header}
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={!!busy}
                    placeholder={source === "command" ? "MCP_API_KEY" : "Authorization"}
                    onChange={(event) => setHeader(event.target.value)}
                    aria-describedby="connector-header-help"
                  />
                  <p id="connector-header-help" className="connection-settings-help">
                    {source === "command"
                      ? "The command gets the key in this variable."
                      : "Authorization sends Bearer and the key. Another header sends the key on its own."}
                  </p>
                </>
              )}
              {authType === "oauth" && (
                <>
                  <label htmlFor="connector-client-id">Client ID (optional)</label>
                  <Input id="connector-client-id" value={clientId} spellCheck={false} autoCapitalize="none" disabled={!!busy} onChange={(event) => setClientId(event.target.value)} aria-describedby="connector-client-help" />
                  <p id="connector-client-help" className="connection-settings-help">
                    Only when the service does not register Mars by itself. Its redirect URL is <code>{state.redirectUri}</code>.
                  </p>
                </>
              )}
              <div className="connection-settings-actions">
                <Button type="submit" disabled={!!busy}>
                  {busy === "add" ? "Adding…" : "Add connector"}
                </Button>
              </div>
            </form>
          </section>
        </>
      )}
      {notice && (
        <p className="connection-settings-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

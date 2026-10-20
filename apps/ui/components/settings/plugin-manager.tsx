"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { piRequest, record } from "@/lib/pi/live-state";
import { parsePlugins, type Plugin } from "@/lib/pi/plugins";
import { Switch } from "@/components/ui/switch";

export function PluginManager({
  renderInterface,
}: {
  renderInterface: (name: string) => ReactNode;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [opened, setOpened] = useState("");
  const refresh = useCallback(async () => {
    const rows = parsePlugins(record(await piRequest("/api/plugins")).plugins);
    setPlugins(rows);
    setLoaded(true);
    setError("");
  }, []);
  useEffect(() => {
    void refresh().catch((failure) =>
      setError(failure instanceof Error ? failure.message : "Could not load plugins."),
    );
  }, [refresh]);
  async function update(
    name: string,
    changes: { enabled?: boolean; uiEnabled?: boolean; tools?: Record<string, boolean> },
  ) {
    setPending(name);
    setError("");
    try {
      await piRequest("/api/plugins", { name, ...changes });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Plugin settings could not be saved.");
    } finally {
      setPending("");
    }
  }
  function card(plugin: Plugin) {
    const visible = plugin.enabled && plugin.uiEnabled && plugin.hasUi;
    return (
      <article key={plugin.name} className="live-plugin-card">
        <header>
          <div>
            <h2>{plugin.title}</h2>
            {plugin.version && <small>{plugin.version}</small>}
          </div>
          <Switch
            checked={plugin.enabled}
            disabled={!!pending}
            aria-label={`Enable ${plugin.title}`}
            onCheckedChange={(enabled) => void update(plugin.name, { enabled })}
          />
        </header>
        {plugin.description && <p>{plugin.description}</p>}
        <div className="live-plugin-controls">
          {plugin.hasUi && (
            <button
              className="live-text-button"
              disabled={!visible}
              onClick={() => setOpened(opened === plugin.name ? "" : plugin.name)}
            >
              {opened === plugin.name && visible ? "Close interface" : "Open interface"}
            </button>
          )}
          <details>
            <summary>Manage {plugin.title}</summary>
            {plugin.hasUi && (
              <label>
                Interface
                <Switch
                  checked={plugin.uiEnabled}
                  disabled={!!pending || !plugin.enabled}
                  aria-label={`Enable ${plugin.title} interface`}
                  onCheckedChange={(uiEnabled) => void update(plugin.name, { uiEnabled })}
                />
              </label>
            )}
            {plugin.tools.map((tool) => (
              <label key={tool.name}>
                <span>
                  <strong>{tool.name}</strong>
                  {tool.description && <small>{tool.description}</small>}
                </span>
                <Switch
                  checked={tool.enabled}
                  disabled={!!pending || !plugin.enabled}
                  aria-label={`Enable ${tool.name}`}
                  onCheckedChange={(enabled) =>
                    void update(plugin.name, { tools: { [tool.name]: enabled } })
                  }
                />
              </label>
            ))}
            {!plugin.tools.length && !plugin.hasUi && <p>No configurable tools.</p>}
          </details>
        </div>
        {pending === plugin.name && <p role="status">Saving settings…</p>}
        {opened === plugin.name && visible && renderInterface(plugin.name)}
      </article>
    );
  }
  return (
    <section className="live-plugin-manager" aria-label="Installed plugins">
      <button
        type="button"
        className="live-text-button"
        disabled={!!pending}
        onClick={() =>
          void refresh().catch((failure) =>
            setError(failure instanceof Error ? failure.message : "Could not refresh plugins."),
          )
        }
      >
        Refresh plugins
      </button>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="live-text-button"
            onClick={() => void refresh().catch(() => undefined)}
          >
            Retry
          </button>
        </p>
      )}
      {!loaded && !error && <p role="status">Loading plugins…</p>}
      {plugins.filter((plugin) => plugin.kind !== "system").map(card)}
      {loaded && !plugins.some((plugin) => plugin.kind !== "system") && (
        <p>No installed plugins yet.</p>
      )}
      {plugins.some((plugin) => plugin.kind === "system") && (
        <details className="live-system-plugins">
          <summary>System capabilities</summary>
          {plugins.filter((plugin) => plugin.kind === "system").map(card)}
        </details>
      )}
    </section>
  );
}

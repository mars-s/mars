"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { piRequest, record } from "@/lib/pi/live-state";
import { parsePlugins, type Plugin } from "@/lib/pi/plugins";
import { ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
            {plugin.description && <p>{plugin.description}</p>}
          </div>
          <Switch
            checked={plugin.enabled}
            disabled={!!pending}
            aria-label={`Enable ${plugin.title}`}
            onCheckedChange={(enabled) => void update(plugin.name, { enabled })}
          />
        </header>
        <div className="live-plugin-controls">
          {plugin.hasUi && (
            <Button
              variant="outline"
              size="sm"
              disabled={!visible}
              aria-expanded={opened === plugin.name && visible}
              onClick={() => setOpened(opened === plugin.name ? "" : plugin.name)}
            >
              {opened === plugin.name && visible ? "Close interface" : "Open interface"}
            </Button>
          )}
          <details>
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              Manage {plugin.title}
            </summary>
            <div className="live-plugin-tools">
              {plugin.hasUi && (
                <label>
                  <span>
                    <strong className="live-plugin-setting">Interface</strong>
                    <small>Show this extension&rsquo;s own panel here.</small>
                  </span>
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
            </div>
          </details>
        </div>
        {pending === plugin.name && <p role="status">Saving settings…</p>}
        {opened === plugin.name && visible && renderInterface(plugin.name)}
      </article>
    );
  }
  const installed = plugins.filter((plugin) => plugin.kind !== "system");
  const system = plugins.filter((plugin) => plugin.kind === "system");
  const reload = () =>
    void refresh().catch((failure) =>
      setError(failure instanceof Error ? failure.message : "Could not refresh plugins."),
    );
  return (
    <section className="live-plugin-manager" aria-label="Installed plugins">
      <div className="live-plugin-toolbar">
        <p>{loaded ? `${installed.length} installed` : ""}</p>
        <Button variant="ghost" size="sm" disabled={!!pending} onClick={reload}>
          <RotateCw aria-hidden="true" />
          Refresh plugins
        </Button>
      </div>
      {error && (
        <p role="alert">
          {error}
          <Button variant="outline" size="xs" onClick={() => void refresh().catch(() => undefined)}>
            Retry
          </Button>
        </p>
      )}
      {!loaded && !error && <p role="status">Loading plugins…</p>}
      {installed.length > 0 && <div className="live-plugin-list">{installed.map(card)}</div>}
      {loaded && !installed.length && (
        <p className="live-plugin-empty">No installed plugins yet.</p>
      )}
      {system.length > 0 && (
        <details className="live-system-plugins">
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            System capabilities
          </summary>
          <div className="live-plugin-list">{system.map(card)}</div>
        </details>
      )}
    </section>
  );
}

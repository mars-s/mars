"use client";

import { AppWindow, ChevronDown, FileText, Globe, LayoutGrid } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { parseCapabilities, parseSuggestions, type Suggestion } from "@/lib/pi/workbench";
import { useHostData } from "@/lib/pi/workbench-client";
import { TOOLS } from "./tools";
import type { TabTarget } from "./workbench-state";

/**
 * The ChatGPT-desktop style New tab: a Tools grid and a Suggested row. Tool
 * availability comes from the host's capabilities route; a tool the host cannot
 * run is shown disabled with the host's reason, never as a working tile.
 */
export function Launcher({ onOpen }: { onOpen: (target: TabTarget) => void }) {
  const { snapshot } = useWorkspace();
  const caps = useHostData("/api/workbench/capabilities", parseCapabilities);
  const suggestions = useHostData("/api/workbench/suggestions", parseSuggestions);
  const [moreOpen, setMoreOpen] = useState(false);
  const extensions = (snapshot?.extensions ?? []).filter((item) => item.enabled !== false && item.uiEnabled !== false);
  const open = (item: Suggestion) =>
    onOpen(
      item.kind === "service"
        ? { kind: "browser", url: `http://localhost:${item.port}/` }
        : item.kind === "extension"
          ? { kind: "extension", hash: item.hash, title: item.title }
          : { kind: "page", name: item.name },
    );
  return (
    <div className="wb-launcher">
      <section aria-labelledby="wb-tools-heading">
        <h2 id="wb-tools-heading">Tools</h2>
        {caps.error && (
          <p className="wb-note" role="alert">
            {caps.error}
          </p>
        )}
        <div className="wb-tools">
          {TOOLS.map((tool) => {
            const cap = caps.data?.[tool.kind];
            const ready = cap?.available === true;
            return (
              <button
                key={tool.kind}
                type="button"
                className="wb-tool"
                disabled={!ready}
                title={ready ? `${tool.title} (${tool.shortcut.label})` : cap?.reason}
                aria-describedby={ready ? undefined : `wb-tool-why-${tool.kind}`}
                onClick={() => onOpen({ kind: tool.kind } as TabTarget)}
              >
                <tool.Icon size={16} aria-hidden="true" />
                <span className="wb-tool-name">{tool.title}</span>
                {ready ? (
                  <kbd aria-hidden="true">{tool.shortcut.label}</kbd>
                ) : (
                  <small id={`wb-tool-why-${tool.kind}`}>{cap ? cap.reason : caps.error ? "Unavailable" : "Checking…"}</small>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="wb-tool"
            aria-expanded={moreOpen}
            aria-controls="wb-more-tools"
            onClick={() => setMoreOpen((value) => !value)}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            <span className="wb-tool-name">More tools…</span>
            <ChevronDown size={16} aria-hidden="true" className="wb-tool-chevron" data-open={moreOpen ? "" : undefined} />
          </button>
        </div>
        {moreOpen && (
          <div id="wb-more-tools" className="wb-more">
            {extensions.length ? (
              extensions.map((extension) => (
                <button
                  key={extension.hash}
                  type="button"
                  className="wb-tool"
                  onClick={() => onOpen({ kind: "extension", hash: extension.hash, title: extension.title })}
                >
                  <AppWindow size={16} aria-hidden="true" />
                  <span className="wb-tool-name">{extension.title}</span>
                  <small>Extension</small>
                </button>
              ))
            ) : (
              <p className="wb-note">No installed extension has an interface yet. Ask Pi to build one.</p>
            )}
          </div>
        )}
      </section>
      <section aria-labelledby="wb-suggested-heading">
        <h2 id="wb-suggested-heading">Suggested</h2>
        {suggestions.error ? (
          <p className="wb-note" role="alert">
            {suggestions.error}
          </p>
        ) : suggestions.data === null ? (
          <p className="wb-note">Looking for running services…</p>
        ) : suggestions.data.length === 0 ? (
          <p className="wb-note">Nothing is running on this machine right now.</p>
        ) : (
          <ul className="wb-suggested">
            {suggestions.data.map((item) => {
              const Icon = item.kind === "service" ? Globe : item.kind === "page" ? FileText : AppWindow;
              const detail =
                item.kind === "service" ? `localhost:${item.port}` : item.kind === "page" ? "Page" : "Extension";
              return (
                <li key={`${item.kind}-${item.kind === "service" ? item.port : item.kind === "page" ? item.name : item.hash}`}>
                  <button type="button" onClick={() => open(item)}>
                    <span className="wb-suggested-icon">
                      <Icon size={20} aria-hidden="true" />
                    </span>
                    <span className="wb-suggested-title">{item.title}</span>
                    <small>{detail}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

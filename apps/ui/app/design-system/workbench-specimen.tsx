"use client";

import { ChevronDown, FileText, Globe, LayoutGrid, Maximize2, Plus, X } from "lucide-react";
import { TOOLS, toolIcon } from "@/components/workbench/tools";
import "@/components/workbench/workbench.css";

/**
 * The workbench header and launcher as drawn in the app, from the same TOOLS list
 * and stylesheet. Static: tiles here do nothing and data is illustrative.
 */
export function WorkbenchSpecimen() {
  const tabs = [
    { id: "a", kind: "launcher" as const, label: "New tab", selected: true },
    { id: "b", kind: "files" as const, label: "README.md", selected: false },
  ];
  return (
    <div className="ds-workbench">
      <section className="wb-pane" aria-label="Workbench specimen" style={{ width: "100%", maxWidth: "none", animation: "none" }}>
        <header className="wb-header">
          <div className="wb-tabs" role="tablist" aria-label="Specimen tabs">
            {tabs.map((tab) => {
              const Icon = toolIcon(tab.kind);
              return (
                <div key={tab.id} className="wb-tab" data-selected={tab.selected ? "" : undefined}>
                  <button type="button" role="tab" aria-selected={tab.selected} tabIndex={-1}>
                    <Icon size={14} aria-hidden="true" />
                    <span>{tab.label}</span>
                  </button>
                  <span className="wb-tab-close" aria-hidden="true">
                    <X size={12} />
                  </span>
                </div>
              );
            })}
            <span className="wb-icon" aria-hidden="true">
              <Plus size={16} />
            </span>
          </div>
          <span className="wb-icon" aria-hidden="true">
            <Maximize2 size={15} />
          </span>
          <span className="wb-icon" aria-hidden="true">
            <X size={16} />
          </span>
        </header>
        <div className="wb-launcher">
          <section>
            <h2>Tools</h2>
            <div className="wb-tools">
              {TOOLS.map((tool, index) => (
                <button key={tool.kind} type="button" className="wb-tool" disabled={index === 1} tabIndex={-1}>
                  <tool.Icon size={16} aria-hidden="true" />
                  <span className="wb-tool-name">{tool.title}</span>
                  {index === 1 ? <small>python3 was not found on the host.</small> : <kbd>{tool.shortcut.label}</kbd>}
                </button>
              ))}
              <button type="button" className="wb-tool" tabIndex={-1}>
                <LayoutGrid size={16} aria-hidden="true" />
                <span className="wb-tool-name">More tools…</span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </div>
          </section>
          <section>
            <h2>Suggested</h2>
            <ul className="wb-suggested">
              {[
                { title: "Docs site", detail: "localhost:3100", Icon: Globe },
                { title: "Release plan", detail: "Page", Icon: FileText },
              ].map((item) => (
                <li key={item.title}>
                  <button type="button" tabIndex={-1}>
                    <span className="wb-suggested-icon">
                      <item.Icon size={20} aria-hidden="true" />
                    </span>
                    <span className="wb-suggested-title">{item.title}</span>
                    <small>{item.detail}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>
    </div>
  );
}

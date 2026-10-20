"use client";

import { ChevronLeft, Maximize2, Minimize2, Plus, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Launcher } from "./launcher";
import { PaneFor } from "./panes";
import { TOOLS, toolIcon, toolTitle } from "./tools";
import { useWorkbench } from "./workbench-context";
import { clampWidth, MIN_WIDTH, type TabTarget, type WorkbenchTab } from "./workbench-state";
import "./workbench.css";

const CHAT_MIN = 420;

function tabLabel(tab: WorkbenchTab) {
  switch (tab.kind) {
    case "files":
      return tab.path ? tab.path.split("/").pop() || "Files" : "Files";
    case "page":
      return tab.name || "New page";
    case "browser":
      return tab.url ? tab.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "Browser";
    case "extension":
      return tab.title;
    case "changes":
      return tab.repo ? `Changes · ${tab.repo}` : "Changes";
    default:
      return toolTitle(tab.kind);
  }
}

export function WorkbenchPane() {
  const { state, dispatch } = useWorkbench();
  const paneRef = useRef<HTMLElement>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const available = () => (paneRef.current?.parentElement?.clientWidth ?? 1200) - CHAT_MIN;
  const resize = (width: number) => dispatch({ type: "resize", width: clampWidth(width, available()) });

  // Tool shortcuts (Ctrl, matching the tile hints) open their pane in a new tab.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey) return;
      if (event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        dispatch(state.open ? { type: "toggle-expanded" } : { type: "open" });
        return;
      }
      const tool = TOOLS.find(
        (item) =>
          item.shortcut.key === event.key.toLowerCase() &&
          !!item.shortcut.shift === event.shiftKey &&
          !!item.shortcut.alt === event.altKey,
      );
      if (!tool) return;
      event.preventDefault();
      dispatch({ type: "open-tool", target: { kind: tool.kind } as TabTarget });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.open]);

  if (!state.open) return null;
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { startX: event.clientX, startWidth: paneRef.current?.offsetWidth ?? state.width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    resize(dragging.current.startWidth - (event.clientX - dragging.current.startX));
  };
  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const width = paneRef.current?.offsetWidth ?? state.width;
    const next: Record<string, number> = {
      ArrowLeft: width + step,
      ArrowRight: width - step,
      Home: available(),
      End: MIN_WIDTH,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    resize(next[event.key]);
  };

  return (
    <>
      {!state.expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workbench"
          aria-valuenow={state.width}
          aria-valuemin={MIN_WIDTH}
          tabIndex={0}
          className="wb-divider"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (dragging.current = null)}
          onLostPointerCapture={() => (dragging.current = null)}
          onKeyDown={onSeparatorKey}
          onDoubleClick={() => resize(Math.round(available() / 2 + CHAT_MIN / 2))}
        />
      )}
      <section
        ref={paneRef}
        className="wb-pane"
        data-expanded={state.expanded ? "" : undefined}
        aria-label="Workbench"
        style={{ width: state.expanded ? undefined : state.width }}
      >
        <header className="wb-header">
          <button type="button" className="wb-icon wb-back" aria-label="Back to chat" onClick={() => dispatch({ type: "close" })}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <div className="wb-tabs" role="tablist" aria-label="Workbench tabs">
            {state.tabs.map((tab) => {
              const Icon = toolIcon(tab.kind);
              const selected = tab.id === active.id;
              return (
                <div key={tab.id} className="wb-tab" data-selected={selected ? "" : undefined}>
                  <button
                    type="button"
                    role="tab"
                    id={`wb-tab-${tab.id}`}
                    aria-selected={selected}
                    aria-controls={`wb-panel-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => dispatch({ type: "select", id: tab.id })}
                    onKeyDown={(event) => {
                      const index = state.tabs.findIndex((item) => item.id === tab.id);
                      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                      if (!delta) return;
                      event.preventDefault();
                      const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length];
                      dispatch({ type: "select", id: next.id });
                      document.getElementById(`wb-tab-${next.id}`)?.focus();
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{tabLabel(tab)}</span>
                  </button>
                  <button
                    type="button"
                    className="wb-tab-close"
                    aria-label={`Close ${tabLabel(tab)} tab`}
                    onClick={() => dispatch({ type: "close-tab", id: tab.id })}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button type="button" className="wb-icon" aria-label="New workbench tab" onClick={() => dispatch({ type: "new-tab" })}>
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="wb-icon wb-expand"
            aria-label={state.expanded ? "Restore workbench" : "Expand workbench"}
            aria-pressed={state.expanded}
            onClick={() => dispatch({ type: "toggle-expanded" })}
          >
            {state.expanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </button>
          <button type="button" className="wb-icon" aria-label="Close workbench" onClick={() => dispatch({ type: "close" })}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`wb-panel-${tab.id}`}
            aria-labelledby={`wb-tab-${tab.id}`}
            className="wb-panel"
            hidden={tab.id !== active.id}
          >
            {tab.kind === "launcher" ? (
              <Launcher onOpen={(target) => dispatch({ type: "open-tool", target, replace: tab.id })} />
            ) : (
              <PaneFor tab={tab} />
            )}
          </div>
        ))}
      </section>
    </>
  );
}

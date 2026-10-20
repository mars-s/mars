"use client";

import { Ellipsis, Plus, Power, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { parseTerminalChunk, parseTerminalCreated } from "@/lib/pi/workbench";
import { connect, HostError, type Link, type LinkState, type Transport } from "./terminal-link";
import type { TerminalView } from "./terminal-view";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import "./terminal-pane.css";

type TerminalTab = Extract<WorkbenchTab, { kind: "terminal" }>;
type Phase = LinkState | { kind: "starting" } | { kind: "failed"; message: string };

async function host(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(15_000),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HostError("The Pi host did not answer.", 0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : "";
    throw new HostError(message || `Pi request failed (${response.status}).`, response.status);
  }
  return data;
}

const base = (id: string) => `/api/workbench/terminal/${id}`;
const transport: Transport = {
  poll: async (id, since, signal) => parseTerminalChunk(await host(`${base(id)}?since=${since}`, undefined, signal)),
  input: async (id, data) => void (await host(`${base(id)}/input`, { data })),
  resize: async (id, cols, rows) => void (await host(`${base(id)}/resize`, { cols, rows })),
};

function statusText(phase: Phase) {
  switch (phase.kind) {
    case "starting":
    case "connecting":
      return "Connecting…";
    case "live":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "ended":
      return phase.exitCode === undefined ? "Session ended" : `Session ended (exit ${phase.exitCode})`;
    case "missing":
      return "Session not found";
    case "failed":
      return "Could not start";
  }
}

/**
 * One host terminal session per tab. The tab stores only the session id, so a reload
 * reattaches and replays what the host kept; closing the tab detaches.
 */
export function TerminalPane({ tab }: { tab: TerminalTab }) {
  const { dispatch } = useWorkbench();
  const screen = useRef<HTMLDivElement>(null);
  const view = useRef<TerminalView | null>(null);
  const link = useRef<Link | null>(null);
  const creating = useRef(false);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const sessionId = tab.sessionId;

  // Mount xterm once; it is fetched on demand so it never weighs on the chat.
  useEffect(() => {
    let disposed = false;
    let mounted: TerminalView | undefined;
    void import("./terminal-view")
      .then(({ mountTerminal }) =>
        mountTerminal(screen.current!, {
          onInput: (bytes) => link.current?.send(bytes),
          onResize: (cols, rows) => link.current?.resize(cols, rows),
        }),
      )
      .then((created) => {
        if (disposed) return created.dispose();
        mounted = created;
        view.current = created;
        setReady(true);
        created.focus();
      })
      .catch(() => !disposed && setPhase({ kind: "failed", message: "The terminal view could not load. Reload the page to try again." }));
    return () => {
      disposed = true;
      mounted?.dispose();
      view.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    const term = view.current;
    if (!term || creating.current) return;
    creating.current = true;
    setPhase({ kind: "starting" });
    term.fit();
    try {
      const id = parseTerminalCreated(await host("/api/workbench/terminal", { cols: term.cols, rows: term.rows }));
      if (!id) throw new HostError("The Pi host did not return a terminal session.", 502);
      dispatch({ type: "update", id: tab.id, patch: { sessionId: id } });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : "The Pi host did not answer." });
    } finally {
      creating.current = false;
    }
  }, [dispatch, tab.id]);

  // No session yet: start one sized to the pane.
  useEffect(() => {
    if (ready && !sessionId) void start();
  }, [ready, sessionId, start]);

  // Attach to the tab's session for as long as the tab exists.
  useEffect(() => {
    const term = view.current;
    if (!ready || !term || !sessionId) return;
    term.write("\x1bc");
    const attached = connect({
      id: sessionId,
      transport,
      onOutput: (bytes, dropped) => {
        if (dropped) term.write("\r\n\x1b[2m[Earlier output was trimmed by the host]\x1b[0m\r\n");
        term.write(bytes);
      },
      onState: setPhase,
    });
    link.current = attached;
    attached.resize(term.cols, term.rows);
    return () => {
      attached.close();
      if (link.current === attached) link.current = null;
    };
  }, [ready, sessionId]);

  const end = async () => {
    if (!sessionId) return;
    await host(`${base(sessionId)}/kill`, {}).catch(() => undefined);
  };
  const fresh = async () => {
    // A detached session cannot be reattached from any tab, so replace rather than orphan it.
    if (phase.kind === "live" || phase.kind === "reconnecting" || phase.kind === "connecting") await end();
    link.current?.close();
    link.current = null;
    view.current?.write("\x1bc");
    if (sessionId) dispatch({ type: "update", id: tab.id, patch: { sessionId: undefined } });
    else void start();
    view.current?.focus();
  };

  const running = phase.kind === "live" || phase.kind === "connecting" || phase.kind === "reconnecting";
  const stopped = phase.kind === "ended" || phase.kind === "missing" || phase.kind === "failed";
  return (
    <div className="wb-term" data-phase={phase.kind}>
      <div className="wb-term-bar">
        <p className="wb-term-status" role="status" aria-live="polite">
          <span className="wb-term-dot" aria-hidden="true" />
          {statusText(phase)}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="wb-icon wb-term-menu" aria-label="Terminal options">
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="wb-term-menu-content">
            <DropdownMenuItem onSelect={() => void fresh()}>
              <Plus aria-hidden="true" />
              New session
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={!sessionId || !running} onSelect={() => void end()}>
              <Power aria-hidden="true" />
              End session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="wb-term-body">
        <div ref={screen} className="wb-term-screen" aria-label="Terminal" onClick={() => view.current?.focus()} />
        {stopped && (
          <div className="wb-term-notice" role={phase.kind === "failed" ? "alert" : undefined}>
            <p>
              {phase.kind === "failed"
                ? phase.message
                : phase.kind === "missing"
                  ? "This session is no longer on the host. It may have timed out or the host restarted."
                  : `${statusText(phase)}.`}
            </p>
            <button type="button" className="wb-term-action" onClick={() => void fresh()}>
              {phase.kind === "failed" ? <RotateCw size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              {phase.kind === "failed" ? "Try again" : "New session"}
            </button>
          </div>
        )}
        {phase.kind === "reconnecting" && (
          <p className="wb-term-notice wb-term-retry">{phase.message} Retrying automatically.</p>
        )}
      </div>
    </div>
  );
}

"use client";

import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { piRequest } from "@/lib/pi/live-state";
import { browseTarget } from "@/lib/pi/workbench";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import "./browser-pane.css";

type BrowserTab = Extract<WorkbenchTab, { kind: "browser" }>;
type Local = { port: number; path: string };
type View =
  | { kind: "idle" }
  | { kind: "minting"; target: Local }
  | { kind: "page"; target: Local; key: string; src: string; loading: boolean; nonce: number }
  | { kind: "external"; url: string }
  | { kind: "error"; message: string; target?: Local };

const PREFIX = /^\/api\/workbench\/browse\/(\d{1,5})\/~[A-Za-z0-9_-]{43}(\/[^?#]*)?/;
const display = ({ port, path }: Local) => `localhost:${port}${path === "/" ? "" : path}`;
const src = (target: Local, key: string) => `/api/workbench/browse/${target.port}/~${key}${target.path.startsWith("/") ? target.path : `/${target.path}`}`;

/**
 * A sub-browser for local web services. Pages load through the host proxy under a
 * per-port key in an iframe sandboxed WITHOUT allow-same-origin, so a page can never
 * read Mars, its cookies or its API. External sites open in a new browser tab.
 */
export function BrowserPane({ tab }: { tab: BrowserTab }) {
  const { dispatch } = useWorkbench();
  const frame = useRef<HTMLIFrameElement>(null);
  const keys = useRef(new Map<number, string>());
  const history = useRef<{ stack: Local[]; index: number }>({ stack: [], index: -1 });
  const [view, setView] = useState<View>({ kind: "idle" });
  const [address, setAddress] = useState(tab.url ?? "");
  const [, setTick] = useState(0);

  const remember = useCallback((url: string) => dispatch({ type: "update", id: tab.id, patch: { url } }), [dispatch, tab.id]);

  const open = useCallback(
    async (target: Local, { push = true }: { push?: boolean } = {}) => {
      if (push) {
        const { stack, index } = history.current;
        history.current = { stack: [...stack.slice(0, index + 1), target], index: index + 1 };
      }
      setTick((n) => n + 1);
      setAddress(display(target));
      remember(`http://localhost:${target.port}${target.path}`);
      let key = keys.current.get(target.port);
      if (!key) {
        setView({ kind: "minting", target });
        try {
          const reply = (await piRequest("/api/workbench/browse-key", { port: target.port })) as { key?: unknown };
          if (typeof reply.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reply.key)) throw Error("Pi did not return a browse key.");
          key = reply.key;
          keys.current.set(target.port, key);
        } catch (failure) {
          setView({ kind: "error", target, message: failure instanceof Error ? failure.message : "Pi did not answer." });
          return;
        }
      }
      setView({ kind: "page", target, key, src: src(target, key), loading: true, nonce: Date.now() });
    },
    [remember],
  );

  const go = (input: string) => {
    const parsed = browseTarget(input);
    if (parsed.kind === "local") return void open({ port: parsed.port, path: parsed.path || "/" });
    if (parsed.kind === "external") {
      setView({ kind: "external", url: parsed.url });
      setAddress(parsed.url);
      remember(parsed.url);
      return;
    }
    setView({ kind: "error", message: "Enter a local address such as localhost:3000, or a full https:// address." });
  };

  // Restore the saved address once per tab.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !tab.url) return;
    restored.current = true;
    const parsed = browseTarget(tab.url);
    if (parsed.kind === "local") void open({ port: parsed.port, path: parsed.path || "/" });
    else if (parsed.kind === "external") setView({ kind: "external", url: parsed.url });
  }, [open, tab.url]);

  // Revoke every key this tab minted when it closes.
  useEffect(() => {
    const minted = keys.current;
    return () => {
      for (const key of minted.values()) void piRequest("/api/workbench/browse-key/revoke", { key }).catch(() => undefined);
    };
  }, []);

  // In-page navigation (links, forms, pushState) is reported by the proxy's shim with
  // postMessage. The frame is opaque, so the message is untrusted: only a message from
  // this frame, naming a path under this tab's own port prefix, moves the address bar.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const reported = (event.data as { marsBrowse?: unknown } | null)?.marsBrowse;
      if (typeof reported !== "string" || reported.length > 4096) return;
      const current = viewRef.current;
      const match = PREFIX.exec(reported);
      if (current.kind !== "page" || !match || Number(match[1]) !== current.target.port) return;
      const rest = reported.slice(match[0].length);
      const target = { port: current.target.port, path: (match[2] || "/") + (rest.startsWith("?") ? rest : "") };
      if (target.path === current.target.path) return;
      // The frame moved by itself: record it without reloading (src stays as loaded).
      const { stack, index } = history.current;
      history.current = { stack: [...stack.slice(0, index + 1), target], index: index + 1 };
      setAddress(display(target));
      remember(`http://localhost:${target.port}${target.path}`);
      setView({ ...current, target });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [remember]);

  const step = (delta: number) => {
    const { stack, index } = history.current;
    const next = stack[index + delta];
    if (!next) return;
    history.current = { stack, index: index + delta };
    void open(next, { push: false });
  };
  const reload = () => {
    if (view.kind === "page") setView({ ...view, src: src(view.target, view.key), loading: true, nonce: Date.now() });
    else if (view.kind === "error" && view.target) void open(view.target, { push: false });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    go(address);
  };
  const { stack, index } = history.current;
  const busy = view.kind === "minting" || (view.kind === "page" && view.loading);

  return (
    <div className="wb-browser">
      <form className="wb-browser-bar" onSubmit={submit} role="search" aria-label="Browser address">
        <button type="button" className="wb-icon" aria-label="Back" disabled={index <= 0} onClick={() => step(-1)}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="wb-icon" aria-label="Forward" disabled={index >= stack.length - 1} onClick={() => step(1)}>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="wb-icon" aria-label="Reload" disabled={view.kind !== "page" && view.kind !== "error"} onClick={reload}>
          {busy ? <LoaderCircle size={15} aria-hidden="true" className="wb-spin" /> : <RotateCw size={15} aria-hidden="true" />}
        </button>
        <label className="wb-browser-address">
          <Globe size={14} aria-hidden="true" />
          <span className="sr-only">Address</span>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="localhost:3000"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            enterKeyHint="go"
            aria-label="Address"
          />
        </label>
      </form>
      <div className="wb-browser-body" aria-busy={busy}>
        {view.kind === "idle" && (
          <div className="wb-empty" role="status">
            <p>Open a local web service, for example <kbd>localhost:3000</kbd>. Running services also appear under Suggested in a new tab.</p>
          </div>
        )}
        {view.kind === "minting" && (
          <div className="wb-empty" role="status">
            <p>Opening {display(view.target)}…</p>
          </div>
        )}
        {view.kind === "external" && (
          <div className="wb-empty" role="status">
            <div className="wb-browser-message">
              <p>Outside sites open in your own browser. The workbench only shows local services on this machine.</p>
              <a className="wb-browser-out" href={view.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} aria-hidden="true" />
                Open in a new tab
              </a>
            </div>
          </div>
        )}
        {view.kind === "error" && (
          <div className="wb-empty" role="alert">
            <div className="wb-browser-message">
              <p>{view.message}</p>
              {view.target && (
                <button type="button" className="wb-browser-out" onClick={reload}>
                  Try again
                </button>
              )}
            </div>
          </div>
        )}
        {view.kind === "page" && (
          <iframe
            ref={frame}
            key={view.nonce}
            title={`Page from ${display(view.target)}`}
            src={view.src}
            className="wb-browser-frame"
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            onLoad={() => setView((current) => (current.kind === "page" ? { ...current, loading: false } : current))}
          />
        )}
      </div>
    </div>
  );
}

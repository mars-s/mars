"use client";

import { ChevronLeft, FilePlus2, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { pageTitle, parsePage, parsePages, parseSavedPage } from "@/lib/pi/workbench";
import { useHostData } from "@/lib/pi/workbench-client";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import "./page-pane.css";

type PageTab = Extract<WorkbenchTab, { kind: "page" }>;
const SAVE_DELAY = 800;
const KEEPALIVE_LIMIT = 60 * 1024;
const PAGES = "/api/workbench/pages";

const errorOf = (data: unknown, status: number) => {
  const text = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : "";
  return text || (status === 401 ? "This private session has expired. Open your authenticated Pi link again." : `Pi answered ${status}.`);
};
const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : "The Pi host did not answer.");

/** Page routes keep their HTTP status so a 409 conflict is told apart from a failure. */
async function pageRequest(path: string, body?: unknown, keepalive = false) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    keepalive,
    signal: keepalive ? undefined : AbortSignal.timeout(15000),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const relative = new Intl.RelativeTimeFormat("en-AU", { numeric: "auto" });
/** Unit, its length in seconds, and the age below which it is used. */
const AGES = [
  ["minute", 60, 3600],
  ["hour", 3600, 86400],
  ["day", 86400, 30 * 86400],
] as const;
function ago(modified: number) {
  const seconds = (Date.now() - modified) / 1000;
  if (seconds < 45) return "just now";
  const age = AGES.find(([, , below]) => seconds < below);
  return age
    ? relative.format(-Math.round(seconds / age[1]), age[0])
    : new Date(modified).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/** A page tab without a name lists pages; with a name it edits that page. */
export function PagePane({ tab }: { tab: PageTab }) {
  const { dispatch } = useWorkbench();
  if (!tab.name)
    return <PageList onOpen={(name) => dispatch({ type: "open-tool", target: { kind: "page", name }, replace: tab.id })} />;
  return <PageEditor key={tab.name} name={tab.name} onList={() => dispatch({ type: "update", id: tab.id, patch: { name: undefined } })} />;
}

function PageList({ onOpen }: { onOpen: (name: string) => void }) {
  const pages = useHostData(PAGES, parsePages);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState("");
  const create = async () => {
    setCreating(true);
    setProblem("");
    try {
      const { status, data } = await pageRequest(PAGES, { text: "" });
      if (status !== 201) throw Error(errorOf(data, status));
      onOpen(parseSavedPage(data).name);
    } catch (failure) {
      setProblem(messageOf(failure));
      setCreating(false);
    }
  };
  return (
    <div className="wb-pages">
      <header className="wb-pages-head">
        <h2>Pages</h2>
        <button type="button" className="wb-icon" aria-label="Refresh pages" onClick={() => void pages.refresh()}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        <button type="button" className="wb-page-new" onClick={() => void create()} disabled={creating}>
          <FilePlus2 size={15} aria-hidden="true" />
          {creating ? "Creating…" : "New page"}
        </button>
      </header>
      {problem && (
        <p className="wb-note wb-page-problem" role="alert">
          Could not create a page: {problem}
        </p>
      )}
      {pages.error ? (
        <p className="wb-note wb-page-problem" role="alert">
          {pages.error}
        </p>
      ) : pages.data === null ? (
        <p className="wb-note">Loading pages…</p>
      ) : pages.data.length === 0 ? (
        <p className="wb-note">No pages yet. Each page is a Markdown file in the workspace pages folder.</p>
      ) : (
        <ul className="wb-page-list" aria-label="Pages">
          {pages.data.map((page) => (
            <li key={page.name}>
              <button type="button" onClick={() => onOpen(page.name)}>
                <FileText size={16} aria-hidden="true" />
                <span className="wb-page-row-title">{page.title}</span>
                <small>
                  {page.name}.md · {ago(page.modified)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Status = "loading" | "saved" | "unsaved" | "saving" | "conflict" | "failed" | "unavailable";
type Doc = { text: string; base: number; remote: number; dirty: boolean; saving: boolean; conflict: boolean };

function MarkdownLink({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}
const remarkPlugins = [remarkGfm];
const markdownComponents = { a: MarkdownLink };

function PageEditor({ name, onList }: { name: string; onList: () => void }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [problem, setProblem] = useState("");
  const [preview, setPreview] = useState(false);
  // `base` is the host's modified time for the version this text started from; a save
  // sends it so the host refuses to overwrite a newer save (409) instead of losing it.
  const doc = useRef<Doc>({ text: "", base: 0, remote: 0, dirty: false, saving: false, conflict: false });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const path = `${PAGES}/${name}`;

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    setStatus("loading");
    try {
      const { status, data } = await pageRequest(path);
      if (status !== 200) throw Error(errorOf(data, status));
      const page = parsePage(data);
      doc.current = { text: page.text, base: page.modified, remote: 0, dirty: false, saving: false, conflict: false };
      setText(page.text);
      setProblem("");
      setStatus("saved");
    } catch (failure) {
      setProblem(messageOf(failure));
      setStatus("unavailable");
    }
  }, [path]);

  const body = (overwrite: boolean) => {
    const baseModified = overwrite ? doc.current.remote : doc.current.base;
    // A page deleted elsewhere reports 0; overwriting then recreates it.
    return { name, text: doc.current.text, ...(baseModified ? { baseModified } : {}) };
  };

  async function save(overwrite = false) {
    const current = doc.current;
    clearTimeout(timer.current);
    if (current.saving || (current.conflict && !overwrite)) return;
    current.saving = true;
    setStatus("saving");
    const payload = body(overwrite);
    try {
      const { status, data } = await pageRequest(PAGES, payload);
      if (status === 409) {
        const modified = (data as { modified?: unknown }).modified;
        current.remote = typeof modified === "number" ? modified : 0;
        current.conflict = true;
        setStatus("conflict");
        return;
      }
      if (status !== 200 && status !== 201) throw Error(errorOf(data, status));
      current.base = parseSavedPage(data).modified;
      current.conflict = false;
      current.dirty = current.text !== payload.text;
      setStatus(current.dirty ? "unsaved" : "saved");
      if (current.dirty) timer.current = setTimeout(() => void save(), SAVE_DELAY);
    } catch (failure) {
      setProblem(messageOf(failure));
      setStatus("failed");
    } finally {
      current.saving = false;
    }
  }

  const edit = (value: string) => {
    const current = doc.current;
    current.text = value;
    current.dirty = true;
    setText(value);
    if (current.conflict) return;
    if (!current.saving) setStatus("unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY);
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Closing the tab or the window sends the pending edit instead of dropping it.
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      const current = doc.current;
      if (!current.dirty || current.conflict || current.saving) return;
      clearTimeout(timer.current);
      const payload = { name, text: current.text, ...(current.base ? { baseModified: current.base } : {}) };
      if (keepalive && new Blob([JSON.stringify(payload)]).size > KEEPALIVE_LIMIT) return;
      current.dirty = false;
      void pageRequest(PAGES, payload, keepalive).catch(() => undefined);
    };
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush(false);
    };
  }, [name]);

  const title = pageTitle(text, name);
  const ready = status !== "loading" && status !== "unavailable";
  return (
    <div className="wb-page">
      <header className="wb-page-head">
        <button type="button" className="wb-icon" aria-label="All pages" title="All pages" onClick={onList}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="wb-page-heading">
          <h2>{title}</h2>
          <small>pages/{name}.md</small>
        </div>
        <div className="wb-page-view" role="group" aria-label="Page view">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)} disabled={!ready}>
            Preview
          </button>
        </div>
      </header>
      <div className="wb-page-status" role="status" aria-live="polite" data-status={status}>
        {status === "loading" && "Loading…"}
        {status === "saved" && "Saved"}
        {status === "unsaved" && "Unsaved changes"}
        {status === "saving" && "Saving…"}
        {status === "conflict" && (
          <>
            <span>Changed elsewhere: reload or overwrite</span>
            <button type="button" onClick={() => void load()}>
              Reload
            </button>
            <button type="button" onClick={() => void save(true)}>
              Overwrite
            </button>
          </>
        )}
        {status === "failed" && (
          <>
            <span>Not saved: {problem}</span>
            <button type="button" onClick={() => void save()}>
              Retry
            </button>
          </>
        )}
        {status === "unavailable" && (
          <>
            <span>{problem}</span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </>
        )}
      </div>
      {preview && ready ? (
        <article className="wb-page-preview" aria-label="Page preview">
          {text.trim() ? (
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
              {text}
            </ReactMarkdown>
          ) : (
            <p className="wb-note">Nothing to preview yet.</p>
          )}
        </article>
      ) : (
        <textarea
          className="wb-page-text"
          aria-label="Page text"
          value={text}
          disabled={!ready}
          onChange={(event) => edit(event.target.value)}
          placeholder={"# Title\n\nWrite in Markdown. Changes save as you type."}
          spellCheck
        />
      )}
    </div>
  );
}

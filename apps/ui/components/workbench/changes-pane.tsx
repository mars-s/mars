"use client";

import { ArrowDown, ArrowUp, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { DiffHighlighterReady } from "@/components/ai/diff-highlighter";
import { diffInput, parsePatch } from "@/components/ai/tool-adapter";
import { EditToolDiffCard } from "@/components/vendor/agent-elements/tools/edit-tool";
import { parseChanges, parseRepos } from "@/lib/pi/workbench";
import { query, useHostData } from "@/lib/pi/workbench-client";
import { changeBar, changeRows, KIND_LABEL, repoLabel, totals, type ChangeRow } from "./changes-model";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import "@/components/vendor/agent-elements/agent-ui.css";
import "./changes-pane.css";

const OPEN_BY_DEFAULT = 3;
const noop = () => {};

/**
 * Read-only change review for a workspace git repository (docs/WORKBENCH.md "Changes").
 * Kokonut Diff Review shell: file list with status and +/- counts; each file opens the
 * 21st EditTool diff card. No accept or reject: Pi owns the working tree.
 */
export function ChangesPane({ tab }: { tab: Extract<WorkbenchTab, { kind: "changes" }> }) {
  const { dispatch } = useWorkbench();
  const repos = useHostData("/api/workbench/repos", parseRepos);
  const list = repos.data;
  const repo = list?.some((item) => item.path === tab.repo) ? tab.repo : list?.[0]?.path;
  const changes = useHostData(repo === undefined ? null : query("/api/workbench/changes", { repo }), parseChanges);
  const current = list?.find((item) => item.path === repo);
  const data = changes.data?.repo === repo ? changes.data : null;
  const rows = useMemo(() => (data ? changeRows(data, parsePatch(data.patch)) : []), [data]);
  const [toggled, setToggled] = useState<{ repo?: string; paths: Set<string> }>({ paths: new Set() });
  const flipped = toggled.repo === repo ? toggled.paths : new Set<string>();
  const defaults = new Set(rows.filter((row) => row.diff).slice(0, OPEN_BY_DEFAULT).map((row) => row.path));
  const isOpen = (path: string) => defaults.has(path) !== flipped.has(path);
  const toggle = (path: string) => {
    const next = new Set(flipped);
    if (!next.delete(path)) next.add(path);
    setToggled({ repo, paths: next });
  };
  const choose = (path: string) => dispatch({ type: "update", id: tab.id, patch: { repo: path } });
  const busy = repos.loading || changes.loading;
  const refresh = () => void Promise.all([repos.refresh(), changes.refresh()]);
  const sum = totals(rows);
  const error = repos.error || changes.error;

  return (
    <div className="wb-changes" aria-busy={busy}>
      <div className="wb-changes-bar">
        {list && list.length > 0 && (
          <label className="wb-changes-repo">
            <span className="sr-only">Repository</span>
            <select value={repo} onChange={(event) => choose(event.target.value)}>
              {list.map((item) => (
                <option key={item.path} value={item.path}>
                  {repoLabel(item.path)}
                  {item.dirty ? " (changed)" : ""}
                </option>
              ))}
            </select>
            <ChevronRight size={14} aria-hidden="true" />
          </label>
        )}
        {current && (
          <span className="wb-changes-branch">
            <GitBranch size={14} aria-hidden="true" />
            <span className="wb-changes-branch-name">{current.branch || "No branch yet"}</span>
            {current.ahead > 0 && (
              <span className="wb-changes-ab" title={`${current.ahead} ahead of upstream`}>
                <ArrowUp size={12} aria-hidden="true" />
                {current.ahead}
                <span className="sr-only"> ahead</span>
              </span>
            )}
            {current.behind > 0 && (
              <span className="wb-changes-ab" title={`${current.behind} behind upstream`}>
                <ArrowDown size={12} aria-hidden="true" />
                {current.behind}
                <span className="sr-only"> behind</span>
              </span>
            )}
          </span>
        )}
        <button type="button" className="wb-icon wb-changes-refresh" aria-label="Refresh changes" onClick={refresh} disabled={busy}>
          <RefreshCw size={15} aria-hidden="true" data-spin={busy ? "" : undefined} />
        </button>
      </div>

      {error ? (
        <div className="wb-empty" role="alert">
          <div className="wb-changes-message">
            <p>{error}</p>
            <button type="button" className="wb-changes-retry" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      ) : list && list.length === 0 ? (
        <div className="wb-empty" role="status">
          <p>No git repositories in the workspace. Clone or create one and refresh.</p>
        </div>
      ) : !data ? (
        <div className="wb-empty" role="status">
          <p>Reading changes…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="wb-empty" role="status">
          <p>No changes. The working tree matches {data.branch || "the last commit"}.</p>
        </div>
      ) : (
        <section className="wb-review" aria-label={`Changes in ${repoLabel(data.repo)}`}>
          <header className="wb-review-head">
            <h2>
              {rows.length} {rows.length === 1 ? "file" : "files"} changed
            </h2>
            <Counts added={sum.added} removed={sum.removed} />
          </header>
          {data.truncated && (
            <p className="wb-note wb-review-note" role="note">
              This change set is large, so some diffs are cut off. Up to 1 MiB of patch and 50 untracked files are shown.
            </p>
          )}
          <ul className="wb-review-list">
            {rows.map((row) => (
              <FileRow key={row.path} row={row} truncated={data.truncated} open={isOpen(row.path)} onToggle={() => toggle(row.path)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Counts({ added, removed, label = true }: { added: number; removed: number; label?: boolean }) {
  return (
    <span className="wb-counts" aria-hidden={label ? undefined : true}>
      <span className="wb-add">+{added}</span>
      <span className="wb-del">−{removed}</span>
      {label && (
        <span className="sr-only">
          {added} added, {removed} removed
        </span>
      )}
    </span>
  );
}

function FileRow({ row, truncated, open, onToggle }: { row: ChangeRow; truncated: boolean; open: boolean; onToggle: () => void }) {
  const id = `wb-diff-${row.path.replace(/[^a-z0-9]/gi, "-")}`;
  const green = changeBar(row.added, row.removed);
  const summary = row.binary ? "binary" : `${row.added} added, ${row.removed} removed`;
  return (
    <li className="wb-review-row">
      <button
        type="button"
        className="wb-review-file"
        aria-label={`${KIND_LABEL[row.kind]}: ${row.path}, ${summary}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <ChevronRight size={14} aria-hidden="true" className="wb-review-chevron" data-open={open ? "" : undefined} />
        <span className="wb-review-status" data-kind={row.kind} title={KIND_LABEL[row.kind]} aria-hidden="true">
          {row.status}
        </span>
        <span className="wb-review-path" title={row.path}>
          <span className="wb-review-dir">{row.dir}</span>
          <span className="wb-review-name">{row.name}</span>
        </span>
        {row.binary ? (
          <span className="wb-review-binary">Binary</span>
        ) : (
          <>
            <Counts added={row.added} removed={row.removed} label={false} />
            <span className="wb-bar" aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => (
                <span key={index} data-tone={row.added + row.removed === 0 ? "none" : index < green ? "add" : "del"} />
              ))}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="wb-review-diff" id={id}>
          <FileDiffBody row={row} truncated={truncated} />
        </div>
      )}
    </li>
  );
}

function FileDiffBody({ row, truncated }: { row: ChangeRow; truncated: boolean }) {
  if (row.binary) return <p className="wb-note">Binary file. Its contents are not shown.</p>;
  if (!row.diff)
    return (
      <p className="wb-note">
        {truncated ? "This diff is past the patch limit and is not shown." : "No line changes to show, for example an empty file or a mode change."}
      </p>
    );
  const stats = [row.added ? `+${row.added}` : "", row.removed ? `-${row.removed}` : ""].filter(Boolean).join(" ");
  return (
    <DiffHighlighterReady fallback={<p className="wb-note">Loading diff…</p>}>
      <EditToolDiffCard
        step={{
          id: `changes:${row.path}`,
          type: "tool-call",
          toolName: row.kind === "added" || row.kind === "untracked" ? "Write" : "Edit",
          toolDetail: row.path,
          duration: 0,
          filePath: row.path,
          diffStats: stats || undefined,
          diffLines: row.diff.lines,
        }}
        input={diffInput(row.diff)}
        state="complete"
        onComplete={noop}
        isCollapsible={row.diff.lines.length > 40}
      />
    </DiffHighlighterReady>
  );
}

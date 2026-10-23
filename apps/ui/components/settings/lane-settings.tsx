"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  closeLane,
  loadLanes,
  mergeLanesNow,
  moveInQueue,
  setLaneOrder,
  setLanePreview,
  setLanesPaused,
  type Lane,
  type LaneList,
} from "@/lib/pi/lanes";
import "./connection-settings.css";
import "./gateway-settings.css";
import "./lane-settings.css";

const LABELS: Record<Lane["state"], string> = {
  open: "Working",
  queued: "Waiting to merge",
  merging: "Merging",
  blocked: "Blocked",
  merged: "Merged",
  closed: "Closed",
};

function LaneRow({ lane, list, busy, act, onOpen }: {
  lane: Lane;
  list: LaneList;
  busy: string;
  act: (key: string, work: () => Promise<unknown>) => void;
  onOpen?: (id: string) => void;
}) {
  const disabled = !!busy;
  const queued = lane.state === "queued" && lane.queuePosition !== null;
  const canPreview = ["open", "blocked", "queued"].includes(lane.state);
  return (
    <li className="gateway-row lane-row" data-state={lane.state}>
      <div className="gateway-row-text">
        <strong>
          {queued && <span className="lane-position">{lane.queuePosition}</span>}
          {lane.title}
        </strong>
        <span>
          <span className="lane-state" data-state={lane.state}>{LABELS[lane.state]}</span>
          {" · "}
          {lane.branch}
          {lane.changed.length ? ` · ${lane.changed.length} file${lane.changed.length === 1 ? "" : "s"}` : ""}
          {lane.mergedCommit ? ` · ${lane.mergedCommit.slice(0, 8)}` : ""}
        </span>
        {lane.note && <span className="gateway-row-detail lane-note">{lane.note}</span>}
        <span className="lane-links">
          {lane.preview && (
            <a className="gateway-link" href={lane.preview.url} target="_blank" rel="noreferrer">
              {lane.preview.state === "running" ? "Open preview" : "Preview starting…"}
            </a>
          )}
          {lane.conversationId && onOpen && (
            <button type="button" className="gateway-link" onClick={() => onOpen(lane.conversationId!)}>Open chat</button>
          )}
        </span>
      </div>
      <div className="gateway-row-actions">
        {queued && (
          <>
            <Button type="button" variant="ghost" size="icon" aria-label={`Move ${lane.title} up`} disabled={disabled || lane.queuePosition === 1}
              onClick={() => act("order", () => setLaneOrder(moveInQueue(list.queue, lane.id, -1)))}>
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={`Move ${lane.title} down`} disabled={disabled || lane.queuePosition === list.queue.length}
              onClick={() => act("order", () => setLaneOrder(moveInQueue(list.queue, lane.id, 1)))}>
              <ArrowDown aria-hidden="true" />
            </Button>
          </>
        )}
        {canPreview && (
          <Button type="button" variant="outline" size="sm" disabled={disabled}
            onClick={() => act("preview:" + lane.id, () => setLanePreview(lane.id, !lane.preview))}>
            {busy === "preview:" + lane.id ? "Starting…" : lane.preview ? "Stop preview" : "Preview"}
          </Button>
        )}
        {lane.state !== "merging" && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => act("close:" + lane.id, () => closeLane(lane.id))}>
            {lane.state === "merged" ? "Dismiss" : "Close"}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Settings, Lanes: chats changing Mars in parallel, their previews and the merge order. */
export function LaneSettings({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
  const [list, setList] = useState<LaneList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => loadLanes().then((next) => { setList(next); setError(""); }), []);
  useEffect(() => {
    let live = true;
    const tick = () => load().catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load lanes."); });
    void tick();
    const timer = setInterval(tick, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [load]);

  const act = useCallback((key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    void work()
      .then(load)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That did not work. Try again."))
      .finally(() => setBusy(""));
  }, [load]);

  const merging = list?.lanes.some((lane) => lane.state === "merging");
  return (
    <div className="connection-settings gateway-settings lane-settings" aria-busy={!!busy}>
      <p className="connection-settings-intro">
        Each chat changing Mars works in its own lane: a separate copy of the code with its own preview link. Finished
        lanes merge into {list?.main ?? "main"} one at a time, in this order, after their checks pass.
      </p>
      {error && <p className="connection-settings-error" role="alert">{error}</p>}
      {!list ? (
        <p className="connection-settings-loading" role="status">Loading lanes…</p>
      ) : (
        <>
          <div className="lane-controls">
            <label className="lane-pause">
              <input type="checkbox" checked={!list.paused} disabled={!!busy}
                onChange={(event) => act("pause", () => setLanesPaused(!event.target.checked))} />
              Merge automatically
            </label>
            {list.queue.length > 0 && (
              <Button type="button" size="sm" disabled={!!busy || merging} onClick={() => act("merge", mergeLanesNow)}>
                {busy === "merge" || merging ? "Merging…" : "Merge now"}
              </Button>
            )}
          </div>
          {list.lanes.length ? (
            <ul className="gateway-list lane-list">
              {list.lanes.map((lane) => (
                <LaneRow key={lane.id} lane={lane} list={list} busy={busy} act={act} onOpen={onOpenConversation} />
              ))}
            </ul>
          ) : (
            <p className="connection-settings-help">
              No lanes yet. Ask a chat to change Mars and it starts one with lane_start.
            </p>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useSyncExternalStore } from "react";
import { CircleAlert } from "lucide-react";
import { piRequest, record } from "@/lib/pi/live-state";

export type HostVersion = {
  commit: string;
  subject: string;
  deployedAt: string;
  repoHead: string;
  /** Commits on main that the live host does not run yet; null when unknown. */
  behind: number | null;
  /** The latest deploy, only when it was interrupted, rolled back or failed to apply. */
  problem: { status: string; detail: string; at: string } | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
/** GET /api/host/version (apps/ui/docs/FULL-CONTROL.md), read defensively; null when absent. */
export function parseHostVersion(value: unknown): HostVersion | null {
  const data = record(value);
  if (!text(data.commit) && !text(data.repoHead)) return null;
  const latest = record(data.latestDeploy);
  return {
    commit: text(data.commit),
    subject: text(data.subject),
    deployedAt: text(data.deployedAt),
    repoHead: text(data.repoHead),
    behind: Number.isInteger(data.behind) ? Number(data.behind) : null,
    problem: text(latest.status) ? { status: text(latest.status), detail: text(latest.detail), at: text(latest.at) } : null,
  };
}

const PROBLEM: Record<string, string> = {
  interrupted: "The last host update was interrupted",
  rolled_back: "The last host update was rolled back",
  apply_failed: "The last host update failed to apply",
};
export const problemTitle = (status: string) => PROBLEM[status] ?? `The last host update ended as ${status.replaceAll("_", " ")}`;

/*
 * One shared poll for every reader (the header notice and Settings), once a minute while any is
 * mounted. Older hosts without the endpoint give null.
 */
let current: HostVersion | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const load = () =>
  piRequest("/api/host/version")
    .then((value) => parseHostVersion(value))
    .catch(() => null)
    .then((next) => {
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      for (const listener of listeners) listener();
    });
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    timer = setInterval(load, 60000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearInterval(timer);
  };
}
export function useHostVersion() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Settings, Connection: which build the host runs and whether main is ahead of it. */
export function HostVersionDetails({ version }: { version: HostVersion | null }) {
  if (!version) return null;
  return (
    <div className="live-host-version">
      <dl className="live-connection-details">
        <div>
          <dt>Host build</dt>
          <dd>
            {version.commit ? <code>{version.commit.slice(0, 8)}</code> : "Unknown"}
            {version.subject && <span> {version.subject}</span>}
          </dd>
        </div>
        <div>
          <dt>Updates</dt>
          <dd>
            {version.behind === null
              ? "Unknown"
              : version.behind === 0
                ? "Up to date with main"
                : `${version.behind} ${version.behind === 1 ? "commit" : "commits"} on main not deployed yet`}
          </dd>
        </div>
      </dl>
      {version.problem && (
        <p role="status" className="live-host-problem">
          <CircleAlert size={14} aria-hidden="true" />
          {problemTitle(version.problem.status)}. {version.problem.detail}
        </p>
      )}
    </div>
  );
}

"use client";

import { Check, CircleAlert, LoaderCircle, Minus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  STEP_LABELS,
  applyUpdate,
  checkUpdates,
  installable,
  loadUpdates,
  setAutoUpdate,
  type UpdateStatus,
  type UpdateStep,
} from "@/lib/pi/updates";
import "./connection-settings.css";
import "./update-settings.css";

const when = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const minutes = Math.round((Date.now() - date.valueOf()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return date.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

/** One sentence for the current state, in the owner's terms. */
function headline(status: UpdateStatus) {
  if (status.running) return { tone: "busy", text: "Updating Mars…" } as const;
  const check = status.check;
  if (!check) return { tone: "quiet", text: "Not checked yet." } as const;
  switch (check.state) {
    case "up_to_date": return { tone: "good", text: "Mars is up to date." } as const;
    case "ahead": return { tone: "good", text: `Up to date. This copy also has ${check.ahead} commit${check.ahead === 1 ? "" : "s"} that ${check.branch} does not.` } as const;
    case "fast_forward":
    case "merge": return { tone: "ready", text: `${check.behind} new commit${check.behind === 1 ? "" : "s"} on ${check.branch}.` } as const;
    case "needs_reconcile": return { tone: "warn", text: `${check.branch} has changes that conflict with this copy.` } as const;
    case "blocked": return { tone: "warn", text: "Mars cannot update right now." } as const;
    default: {
      const exhaustive: never = check.state;
      return exhaustive;
    }
  }
}

const OUTCOME_TEXT = {
  updated: "Updated",
  failed: "Update stopped before anything changed",
  rolled_back: "The new version was unhealthy, so Mars went back to the old one",
  rollback_failed: "The update failed and going back also failed",
  interrupted: "An interrupted update was undone",
} as const;

function StepIcon({ step }: { step: UpdateStep }) {
  if (step.status === "running") return <LoaderCircle className="update-step-spin" aria-hidden="true" />;
  if (step.status === "failed") return <CircleAlert aria-hidden="true" />;
  if (step.status === "skipped") return <Minus aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}
function Steps({ steps, label }: { steps: UpdateStep[]; label: string }) {
  return (
    <ol className="update-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.name + index} data-status={step.status}>
          <StepIcon step={step} />
          <span>{STEP_LABELS[step.name] ?? step.name}</span>
          {step.status === "failed" && step.detail && <small>{step.detail}</small>}
          <span className="sr-only">{step.status}</span>
        </li>
      ))}
    </ol>
  );
}

/** Settings, Updates: is a newer Mars on main, install it, and how the last update went. */
export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "apply" | "auto">("");
  const [reload, setReload] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadUpdates(controller.signal)
        .then((next) => { setStatus(next); setError(""); })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          // While an update restarts Mars the host is briefly unreachable; keep the last view.
          if (startedRef.current) return;
          setError(cause instanceof Error ? cause.message : "Could not load updates.");
        });
    void load();
    const timer = setInterval(load, status?.running || startedRef.current ? 2000 : 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload, status?.running]);

  // The update finished: its result replaces the "building" notice.
  const lastId = status?.last?.id;
  useEffect(() => {
    if (!startedRef.current || !lastId || status?.running) return;
    startedRef.current = false;
    setNotice("");
  }, [lastId, status?.running]);

  const act = useCallback(async (kind: "check" | "apply" | "auto", work: () => Promise<void>) => {
    setBusy(kind);
    setError("");
    setNotice("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That did not work. Try again."); } finally { setBusy(""); }
  }, []);

  const check = status?.check;
  const head = status ? headline(status) : null;
  const canInstall = !!check && installable(check.state) && !status?.running;

  return (
    <div className="connection-settings update-settings" aria-busy={!!busy}>
      {error && <p className="connection-settings-error" role="alert">{error}</p>}
      {!status || !head ? (
        <div className="connection-settings-loading">
          {!error ? <p role="status">Loading updates…</p> : <Button variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        </div>
      ) : (
        <>
          <section aria-labelledby="update-state-heading">
            <div className="update-state" data-tone={head.tone}>
              <h3 id="update-state-heading" role="status">{head.text}</h3>
              <p>
                Running <code>{status.head || "unknown"}</code>
                {check && <> · checked {when(check.checkedAt)}</>}
              </p>
            </div>
            {check && check.commits.length > 0 && !status.running && (
              <ul className="update-commits" aria-label={`New on ${check.branch}`}>
                {check.commits.map((commit) => (
                  <li key={commit.sha}><code>{commit.sha}</code><span>{commit.subject}</span></li>
                ))}
              </ul>
            )}
            {check?.state === "merge" && !status.running && (
              <p className="connection-settings-help">
                {check.reconciled
                  ? "A reconciled merge is ready. Updating installs it."
                  : `This copy has ${check.ahead} commit${check.ahead === 1 ? "" : "s"} of its own. They merge cleanly with ${check.branch}; updating makes the merge commit here. Push it to GitHub afterwards to keep them.`}
              </p>
            )}
            {check && check.blockers.length > 0 && !status.running && (
              <div className="update-blocker">
                {check.blockers.map((blocker) => (
                  <div key={blocker.code}>
                    <p>{blocker.message}</p>
                    {blocker.files.length > 0 && (
                      <ul aria-label="Files involved">{blocker.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
                    )}
                  </div>
                ))}
                {check.state === "needs_reconcile" && (
                  <p className="connection-settings-help">Mars will not merge these by itself. Ask Mars in a chat to reconcile the update, or merge them on the server.</p>
                )}
              </div>
            )}
            {status.running && <Steps steps={status.running.steps} label="Update progress" />}
            <div className="connection-settings-actions">
              <Button variant="outline" disabled={!!busy || !!status.running}
                onClick={() => void act("check", async () => setStatus(await checkUpdates()))}>
                {busy === "check" ? "Checking…" : "Check now"}
              </Button>
              {canInstall && (
                <Button disabled={!!busy}
                  onClick={() => void act("apply", async () => {
                    const result = await applyUpdate();
                    if (result.started) { startedRef.current = true; setNotice("Building the new version. Mars restarts when it is ready, which takes a minute or two."); }
                    else setNotice(result.detail || result.next);
                    setStatus(await loadUpdates());
                  })}>
                  {busy === "apply" ? "Starting…" : "Update now"}
                </Button>
              )}
            </div>
            {notice && <p className="connection-settings-notice" role="status">{notice}</p>}
          </section>

          {status.last && !status.running && (
            <section aria-labelledby="update-last-heading">
              <div className="connection-settings-heading">
                <h3 id="update-last-heading">Last update</h3>
                <span>{status.last.from && status.last.result ? `${status.last.from} → ${status.last.result}` : ""}</span>
              </div>
              <p className="update-outcome" data-outcome={status.last.outcome}>{OUTCOME_TEXT[status.last.outcome]}.</p>
              {status.last.outcome !== "updated" && status.last.detail && <p className="update-detail">{status.last.detail}</p>}
              <p className="connection-settings-help">{status.last.next}</p>
              {status.last.outcome !== "updated" && <Steps steps={status.last.steps} label="Steps of the last update" />}
            </section>
          )}

          <section aria-labelledby="update-auto-heading">
            <div className="update-auto">
              <div>
                <h3 id="update-auto-heading">Install updates automatically</h3>
                <p className="connection-settings-help">
                  Mars checks {check?.branch ?? "main"} every 6 hours. When this is on and no conversation is running,
                  it installs updates that need no merging decisions. Conflicts always wait for you.
                </p>
              </div>
              <Switch
                checked={status.auto}
                disabled={!!busy}
                aria-labelledby="update-auto-heading"
                onCheckedChange={(auto) => void act("auto", async () => setStatus(await setAutoUpdate(auto)))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

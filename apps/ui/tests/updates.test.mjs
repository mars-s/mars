import assert from "node:assert/strict";
import test from "node:test";
import { installable, parseUpdateStatus } from "../lib/pi/updates.ts";
import { parseUpdateBadge } from "../lib/pi/live-state.ts";

test("update status keeps known fields and bounds the rest", () => {
  const parsed = parseUpdateStatus({
    status: {
      state: "needs_reconcile", checkedAt: "2026-10-22T01:00:00Z", branch: "main", head: "c1787bd53fc8aaaa", target: "9a41e02b7c10", behind: 2, ahead: 1,
      commits: ["9a41e02 Tidy", "not-a-commit-line", ...Array.from({ length: 40 }, (_, i) => `abc${i} More`)],
      blockers: [{ code: "conflict", message: "Both changed it.", files: ["a.ts", 7, "b.ts"], secret: "x" }],
      reconciled: false, next: "Merge.",
    },
    head: "c1787bd53fc8", installed: { at: "2026-10-22T00:00:00Z" }, settings: { auto: "yes" },
    running: null,
    last: { id: "1", outcome: "rolled_back", detail: "health: unhealthy", from: "a", result: "b", restarted: true, next: "Fix it.", steps: [{ name: "health", status: "failed", detail: "unhealthy" }, { name: "x", status: "weird" }] },
  });
  assert.equal(parsed.check?.state, "needs_reconcile");
  assert.equal(parsed.check?.head.length, 12, "commit ids are bounded");
  assert.equal(parsed.check?.commits.length, 19, "at most 20 lines are read, and the malformed one is dropped");
  assert.deepEqual(parsed.check?.commits[0], { sha: "9a41e02", subject: "Tidy" });
  assert.deepEqual(parsed.check?.blockers[0].files, ["a.ts", "b.ts"], "non-string files are dropped");
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(parsed.auto, false, "only a real true turns automatic installs on");
  assert.equal(parsed.last?.outcome, "rolled_back");
  assert.equal(parsed.last?.steps[1].status, "done", "an unknown step state is not shown as failed");
  assert.throws(() => parseUpdateStatus({}), /unavailable/);
});

test("an unknown state or outcome is not trusted", () => {
  const parsed = parseUpdateStatus({ status: { state: "installing-now" }, head: "x", last: { outcome: "exploded" } });
  assert.equal(parsed.check, null);
  assert.equal(parsed.last, null);
  assert.deepEqual(parseUpdateBadge({ state: "nonsense", behind: -3 }), { state: "unknown", behind: 0 });
  assert.deepEqual(parseUpdateBadge(undefined), { state: "unknown", behind: 0 });
  assert.deepEqual(parseUpdateBadge({ state: "merge", behind: 4 }), { state: "merge", behind: 4 });
});

test("only fast-forward and merge are installable", () => {
  assert.deepEqual(["up_to_date", "ahead", "fast_forward", "merge", "needs_reconcile", "blocked", "updating", "unknown"].filter(installable), ["fast_forward", "merge"]);
});

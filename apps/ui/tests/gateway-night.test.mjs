import assert from "node:assert/strict";
import test from "node:test";
import { parseGateway } from "../lib/pi/gateway.ts";

const base = { adapters: [{ channel: "telegram", state: "running", detail: "", failures: 0 }], bindings: [], pairings: [], audit: [], outbox: 0 };

test("allowed senders merge the approved list with the host configured owners", () => {
  const { senders } = parseGateway({
    ...base,
    allowed: { telegram: ["6660002", "6660001"], api: ["owner"], discord: [42, "", "4000001"] },
    owners: { telegram: ["6660001"], api: ["owner"] },
  });
  assert.deepEqual(senders, [
    { channel: "telegram", sender: "6660001", approved: true, configured: true },
    { channel: "api", sender: "owner", approved: true, configured: true },
    { channel: "telegram", sender: "6660002", approved: true, configured: false },
    { channel: "discord", sender: "4000001", approved: true, configured: false },
  ], "one row per sender; only string ids");
});

test("a configured owner that is not approved has no approved flag, so it shows no Remove", () => {
  const { senders } = parseGateway({ ...base, owners: { discord: ["4000002"] } });
  assert.deepEqual(senders, [{ channel: "discord", sender: "4000002", approved: false, configured: true }]);
});

test("sender rows are bounded and a missing or odd list gives none", () => {
  assert.deepEqual(parseGateway(base).senders, []);
  assert.deepEqual(parseGateway({ ...base, allowed: ["x"], owners: "y" }).senders, []);
  const many = parseGateway({ ...base, allowed: { telegram: Array.from({ length: 500 }, (_, i) => String(i)) } }).senders;
  assert.equal(many.length, 200);
  assert.equal(parseGateway({ ...base, allowed: { telegram: ["9".repeat(300)] } }).senders[0].sender.length, 64);
});

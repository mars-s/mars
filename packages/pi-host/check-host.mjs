import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { createRegistry } from "@earendil-works/pi-durable";
import { tmpdir } from "node:os";
const fixture = await mkdtemp(tmpdir() + "/mars-host-");
process.env.MARS_PI_ROOT = fixture;
const { WORK, ROOT, Credentials } = await import("./security.mjs");
const { ExtensionStore } = await import("./extension-store.mjs");
await mkdir(ROOT + "/evidence", { recursive: true });
const source = WORK + "/.host-test";
await mkdir(source, { recursive: true });
const code =
  "export default {name:'test-ping',tools:[{name:'test_ping',description:'test',parameters:{type:'object',properties:{}},replay:'safe',execute:async()=>({output:[{type:'text',text:'ping'}]})}]};";
for (const [name, body] of Object.entries({
  "manifest.json": JSON.stringify({ name: "test-ping", version: "1.0.0", title: "Test ping" }),
  "extension.mjs": code,
  "client.js": 'export function mount(root){root.textContent="Test ping"}',
}))
  await writeFile(source + "/" + name, body);
const base = await mkdtemp(ROOT + "/evidence/store-test-");
const registry = createRegistry();
const store = new ExtensionStore(registry, base);
await store.boot();
const receipt = await store.install(".host-test");
assert.equal(receipt.application, "applied");
assert.equal(store.catalogue.length, 1);
assert.equal((await store.install(".host-test")).changed, false);
const reloaded = new ExtensionStore(createRegistry(), base);
await reloaded.boot();
assert.equal(reloaded.catalogue[0].hash, receipt.hash);
await writeFile(base + "/extensions/" + receipt.hash + "/client.js", "tampered", {
  mode: 0o400,
}).catch(async () => {
  await rm(base + "/extensions/" + receipt.hash + "/client.js");
  await writeFile(base + "/extensions/" + receipt.hash + "/client.js", "tampered");
});
await assert.rejects(() => new ExtensionStore(createRegistry(), base).boot(), /hash mismatch/);
const authPath = base + "/auth-test.json";
const creds = new Credentials(authPath);
await Promise.all([
  creds.modify("test", async () => ({ type: "api_key", key: "fixture-only" })),
  creds.modify("second", async () => ({ type: "api_key", key: "fixture-2" })),
]);
assert.equal((await creds.list()).length, 2);
assert.equal((await creds.read("test")).key, "fixture-only");
await creds.delete("test");
assert.equal(await creds.read("test"), undefined);
await rm(source, { recursive: true });
await rm(base, { recursive: true });
console.log(
  "Native extension install, idempotency, saved reload, tamper rejection and serial credential storage pass.",
);

await rm(fixture, { recursive: true, force: true });

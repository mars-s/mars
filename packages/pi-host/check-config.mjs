import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, mergeLayers, userConfigDir } from "./config.mjs";

const root = await mkdtemp(join(tmpdir(), "mars-config-"));
try {
  const dir = join(root, "mars");
  await mkdir(dir);
  const write = (value) => writeFile(join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
  const summary = (result) => result.layers.map((l) => `${l.name}:${l.applied}${l.error ? "!" : ""}`).join(",");

  // Shipped defaults are what a fresh clone gets.
  let result = await loadConfig({ env: {}, dir });
  assert.deepEqual(result.config.models, { concurrency: 4, maxOutputTokens: 8192 });
  assert.equal(summary(result), "default:true,user:false,env:false");

  // A personal layer overrides only what it names.
  await write({ models: { concurrency: 16 } });
  result = await loadConfig({ env: {}, dir });
  assert.deepEqual(result.config.models, { concurrency: 16, maxOutputTokens: 8192 });
  assert.equal(summary(result), "default:true,user:true,env:false");

  // Environment remains the highest-precedence operator override.
  result = await loadConfig({ env: { MARS_MODEL_CONCURRENCY: "8" }, dir });
  assert.equal(result.config.models.concurrency, 8);

  // Broken personal layers are reported and skipped instead of stopping the host.
  for (const broken of ["{not json", { models: { concurrency: 33 } }, { models: { concurrency: 1.5 } }, "[]"]) {
    await write(broken);
    result = await loadConfig({ env: {}, dir });
    assert.equal(result.config.models.concurrency, 4);
    assert.ok(result.layers[1].error, "user layer error is reported");
  }
  result = await loadConfig({ env: { MARS_MODEL_CONCURRENCY: "lots" }, dir: join(root, "missing") });
  assert.equal(result.config.models.concurrency, 4);
  assert.ok(result.layers[2].error);

  assert.deepEqual(mergeLayers({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }), { a: { b: 1, c: 3 }, d: [2] });
  assert.equal(userConfigDir({ HOME: "/h" }), "/h/.config/mars");
  assert.equal(userConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }), "/x/mars");
  assert.equal(userConfigDir({ MARS_CONFIG_DIR: "/m" }), "/m");
  console.log("config layer checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

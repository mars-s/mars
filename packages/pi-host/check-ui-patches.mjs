import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NODE, NPM } from "./security.mjs";
import { UiPatchStore } from "./ui-patches.mjs";

const root = await mkdtemp(join(tmpdir(), "mars-ui-patches-"));
const source = join(root, "source");
const base = join(root, "records");
const results = [];
async function test(name, run) {
  await run();
  results.push({ name, passed: true });
}
try {
  const secret = join(root, "host-secret");
  await writeFile(secret, "fixture-private", { mode: 0o600 });
  await mkdir(join(source, "components"), { recursive: true });
  await mkdir(join(source, "node_modules"));
  await mkdir(join(source, "scripts"));
  await writeFile(join(source, "components", "status.tsx"), "initial\n");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "node scripts/check.mjs typecheck",
        lint: "node scripts/check.mjs lint",
        build: "node scripts/check.mjs build",
      },
    }),
  );
  await writeFile(
    join(source, "scripts", "check.mjs"),
    `import {readFile,writeFile} from 'node:fs/promises';
const input=await readFile('components/status.tsx','utf8');
if(input.includes(process.argv[2]+'-fail'))process.exit(1);
if(process.env.SECRET_SENTINEL)throw Error('Environment secret leaked');
try{await readFile(${JSON.stringify(secret)});throw Error('Host file leaked')}catch(e){if(e.message==='Host file leaked')throw e}
if(process.argv[2]==='build')await writeFile('build-proof.txt','snapshot build ran');`,
  );
  process.env.SECRET_SENTINEL = "never-expose";
  const store = new UiPatchStore({ source, base });
  await test("reject traversal, server/auth/config paths and oversize", async () => {
    for (const path of [
      "../app/page.tsx",
      "/app/page.tsx",
      "app/api/auth/route.ts",
      "lib/pi/transport.ts",
      ".env",
      "package.json",
      "components/../page.tsx",
      "components/foo\\bar.tsx",
    ])
      await assert.rejects(store.stage({ files: [{ path, content: "bad" }] }));
    await assert.rejects(
      store.stage({ files: [{ path: "components/large.tsx", content: "x".repeat(200001) }] }),
    );
  });
  await test("reject symlink target", async () => {
    await symlink("/tmp", join(source, "components", "escape"));
    await assert.rejects(
      store.stage({ files: [{ path: "components/escape/out.tsx", content: "bad" }] }),
      /Symlinks/,
    );
    await rm(join(source, "components", "escape"));
  });
  await test("actual subprocess failures leave source untouched", async () => {
    for (const phase of ["typecheck", "lint", "build"]) {
      const patch = await store.stage({
        files: [{ path: "components/status.tsx", content: phase + "-fail\n" }],
      });
      const result = await store.validate(patch);
      assert.equal(result.status, "validation-failed");
      assert.equal(result.checks.at(-1).exitCode, 1);
      assert.equal(await readFile(join(source, "components/status.tsx"), "utf8"), "initial\n");
      await assert.rejects(store.promote(patch), /validated/);
    }
  });
  await test("stale source blocks validation", async () => {
    const patch = await store.stage({
      files: [{ path: "components/status.tsx", content: "updated\n" }],
    });
    await writeFile(join(source, "components/status.tsx"), "external\n");
    await assert.rejects(store.validate(patch), /stale/);
    await writeFile(join(source, "components/status.tsx"), "initial\n");
  });
  let promoted;
  await test("validate all commands in namespace, promote and retain receipts", async () => {
    promoted = await store.stage({
      files: [
        { path: "components/status.tsx", content: "updated\n" },
        { path: "components/new.tsx", content: "new\n" },
      ],
    });
    const validation = await store.validate(promoted);
    assert.equal(validation.status, "validated", JSON.stringify(validation));
    assert.equal(validation.checks.length, 3);
    assert.ok(validation.checks.every((check) => check.exitCode === 0));
    await assert.rejects(readFile(join(source, "build-proof.txt")), { code: "ENOENT" });
    assert.equal((await store.promote(promoted)).status, "promoted");
    assert.equal(await readFile(join(source, "components/status.tsx"), "utf8"), "updated\n");
    const files = await readdir(join(base, promoted.id));
    assert.ok(files.some((path) => path.endsWith("-validated.json")));
    assert.ok(files.some((path) => path.endsWith("-promoted.json")));
  });
  await test("rollback stale protection then restart and exact rollback", async () => {
    await writeFile(join(source, "components/status.tsx"), "outside\n");
    await assert.rejects(store.rollback(promoted), /stale/);
    await writeFile(join(source, "components/status.tsx"), "updated\n");
    const recreated = new UiPatchStore({ source, base });
    assert.equal((await recreated.status(promoted)).status, "promoted");
    assert.equal((await recreated.rollback(promoted)).status, "rolled-back");
    assert.equal(await readFile(join(source, "components/status.tsx"), "utf8"), "initial\n");
    await assert.rejects(readFile(join(source, "components/new.tsx")), { code: "ENOENT" });
  });
  await test("validated patch rejects later changes at promotion", async () => {
    const patch = await store.stage({
      files: [{ path: "components/status.tsx", content: "stale promotion\n" }],
    });
    assert.equal((await store.validate(patch)).status, "validated");
    await writeFile(join(source, "components/status.tsx"), "changed\n");
    await assert.rejects(store.promote(patch), /stale/);
    await writeFile(join(source, "components/status.tsx"), "initial\n");
  });
  await test("interrupted promotion restores originals on startup", async () => {
    const patch = await store.stage({
      files: [
        { path: "components/status.tsx", content: "interrupted\n" },
        { path: "components/interrupted.tsx", content: "created\n" },
      ],
    });
    await store.receipt(patch.id, "applying");
    await writeFile(join(source, "components/status.tsx"), "interrupted\n");
    const recreated = new UiPatchStore({ source, base });
    assert.equal((await recreated.status(patch)).status, "recovered");
    assert.equal(await readFile(join(source, "components/status.tsx"), "utf8"), "initial\n");
  });
  await test("interrupted recovery refuses external edits", async () => {
    const patch = await store.stage({
      files: [{ path: "components/status.tsx", content: "interrupted again\n" }],
    });
    await store.receipt(patch.id, "applying");
    await writeFile(join(source, "components/status.tsx"), "outside edit\n");
    const recreated = new UiPatchStore({ source, base });
    await assert.rejects(recreated.status(patch), /external edit/);
    await writeFile(join(source, "components/status.tsx"), "initial\n");
    await recreated.status(patch);
  });
  await test("workspace UI validation resolves Next and TypeScript independently of filtered native dependencies", async () => {
    const workspace = join(root, "workspace");
    const uiSource = join(workspace, "apps/ui");
    const uiDeps = join(workspace, "node_modules");
    const native = join(root, "native-host");
    const nativeDeps = join(native, "node_modules");
    await mkdir(join(uiSource, "components"), { recursive: true });
    await mkdir(join(uiSource, "scripts"));
    await mkdir(nativeDeps, { recursive: true });
    for (const name of ["next", "typescript"]) {
      await mkdir(join(uiDeps, name), { recursive: true });
      await writeFile(join(uiDeps, name, "package.json"), JSON.stringify({ name, version: "0.0.0-ui-fixture" }));
    }
    await writeFile(join(nativeDeps, "native-only.txt"), "filtered Pi dependencies, no Next or TypeScript");
    await writeFile(join(uiSource, "components/status.tsx"), "initial\n");
    await writeFile(join(uiSource, "package.json"), JSON.stringify({ scripts: { check: "node scripts/check.mjs" } }));
    await writeFile(join(uiSource, "scripts/check.mjs"), `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
for (const name of ['next','typescript']) assert.equal(require(name + '/package.json').version, '0.0.0-ui-fixture');
assert.equal(await readFile('components/status.tsx','utf8'),'workspace updated\\n');`);
    // Load the real production module with a native-only deployment environment.
    // The UI tree is hoisted separately and has no local node_modules directory.
    await writeFile(join(native, "ui-patches.mjs"), await readFile(new URL("./ui-patches.mjs", import.meta.url)));
    await writeFile(join(native, "security.mjs"), `export const ROOT=${JSON.stringify(native)}, NODE=${JSON.stringify(NODE)}, NPM=${JSON.stringify(NPM)}, UI_DIR=${JSON.stringify(uiSource)}, DEPENDENCIES=${JSON.stringify(nativeDeps)};`);
    const { UiPatchStore: IsolatedStore } = await import(pathToFileURL(join(native, "ui-patches.mjs")).href);
    const isolated = new IsolatedStore({ source: uiSource, base: join(root, "workspace-records"), commands: [["run", "check"]] });
    const patch = await isolated.stage({ files: [{ path: "components/status.tsx", content: "workspace updated\n" }] });
    const validation = await isolated.validate(patch);
    assert.equal(validation.status, "validated", JSON.stringify(validation));
    assert.equal(validation.checks[0].exitCode, 0);
    assert.equal(await readFile(join(uiSource, "components/status.tsx"), "utf8"), "initial\n");
  });
  console.log(
    JSON.stringify(
      {
        passed: true,
        tests: results,
        note: "Actual npm subprocesses and Bubblewrap run against a local fixture. Real Next.js build/HMR requires the app-level check.",
      },
      null,
      2,
    ),
  );
} finally {
  delete process.env.SECRET_SENTINEL;
  await rm(root, { recursive: true, force: true });
}

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  lstat,
  stat,
  unlink,
  rm,
  symlink,
} from "node:fs/promises";
import { ROOT, NODE, NPM, UI_DIR } from "./security.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const roots = ["app", "components", "lib", "hooks", "public", "tests", "scripts"];
const rootFiles =
  /^(?:package(?:-lock)?\.json|tsconfig\.json|next-env\.d\.ts|(?:next|postcss|eslint|playwright)\.config\.[a-z]+|components\.json)$/;
const permitted = (path) =>
  /^(?:app\/(?:page\.tsx|error\.tsx|globals\.css)|components\/[a-zA-Z0-9_/-]+\.(?:tsx?|css)|lib\/ui\/[a-zA-Z0-9_/-]+\.(?:tsx?|css))$/.test(
    path,
  );

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function safePath(root, path) {
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !permitted(path)
  )
    throw Error("Path is outside the frontend patch allowlist");
  let target = root;
  for (const part of path.split("/")) {
    target = join(target, part);
    const info = await exists(target);
    if (info?.isSymbolicLink()) throw Error("Symlinks are not allowed in patch paths");
  }
  return target;
}
async function sourceFiles(root) {
  if ((await lstat(root)).isSymbolicLink()) throw Error("Source root cannot be a symlink");
  const files = [];
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw Error("Source symlinks are not supported: " + path);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await walk(path + "/" + name);
    } else if (info.isFile()) files.push(path);
  }
  for (const name of (await readdir(root)).sort())
    if (roots.includes(name) || rootFiles.test(name)) await walk(name);
  return files.sort();
}
async function fingerprint(root) {
  const hash = createHash("sha256");
  for (const path of await sourceFiles(root))
    hash.update(path + "\0" + digest(await readFile(join(root, path))) + "\n");
  return hash.digest("hex");
}
async function replace(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".patch-" + randomUUID();
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

async function uiDependencies(source) {
  const require = createRequire(join(source, "package.json"));
  try {
    const next = require.resolve("next/package.json");
    const marker = "/node_modules/";
    const index = next.lastIndexOf(marker);
    if (index !== -1) return next.slice(0, index + marker.length - 1);
    throw Error("Next.js must be installed through the UI workspace dependencies");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // Small local validation fixtures and standalone UI installs may have their
    // own dependency directory. A filtered host SDK tree is never a UI fallback.
    const local = join(source, "node_modules");
    if ((await stat(local).catch(() => null))?.isDirectory()) return local;
    throw Error("UI dependencies are missing. Run npm ci in the Mars checkout.");
  }
}

export class UiPatchStore {
  sourceRead({ path }) {
    return this.serial(async () => {
      const target = await safePath(this.source, path);
      const info = await lstat(target);
      if (!info.isFile() || info.size > 200000) throw Error('Source file must be regular and under 200KB');
      return {path, content: await readFile(target, 'utf8')};
    });
  }
  constructor({
    source = UI_DIR,
    base = ROOT + "/data/ui-patches",
    commands = [
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "build"],
    ],
    timeoutMs = 600000,
  } = {}) {
    this.source = resolve(source);
    this.base = resolve(base);
    this.commands = commands;
    this.timeoutMs = timeoutMs;
    this.chain = Promise.resolve();
    this.ready = false;
  }
  serial(operation) {
    const task = this.chain.then(async () => {
      await this.boot();
      return operation();
    });
    this.chain = task.catch(() => {});
    return task;
  }
  async boot() {
    if (this.ready) return;
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.base)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const state = await this.read(id);
      if (state.status === "applying" || state.status === "rolling-back") {
        await this.restore(state.stage);
        await this.receipt(id, "recovered", {
          reason: "Interrupted application restored from staged originals",
        });
      }
    }
    this.ready = true;
  }
  async receipt(id, status, details = {}) {
    const dir = join(this.base, id);
    const sequence = (await readdir(dir)).filter((name) => /^\d+-.*\.json$/.test(name)).length;
    const value = { id, status, at: new Date().toISOString(), ...details };
    await writeFile(
      join(dir, String(sequence).padStart(5, "0") + "-" + status + ".json"),
      JSON.stringify(value, null, 2),
      { flag: "wx", mode: 0o400 },
    );
    return value;
  }
  async read(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid patch ID");
    const dir = join(this.base, id);
    const stage = JSON.parse(await readFile(join(dir, "stage.json"), "utf8"));
    const receipts = [];
    for (const name of (await readdir(dir)).filter((name) => /^\d+-.*\.json$/.test(name)).sort())
      receipts.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    return { id, stage, receipts, status: receipts.at(-1)?.status || "staged" };
  }
  status({ id }) {
    return this.serial(async () => {
      const value = await this.read(id);
      return {
        id,
        status: value.status,
        files: value.stage.files.map((file) => file.path),
        baseFingerprint: value.stage.baseFingerprint,
        receipts: value.receipts,
      };
    });
  }
  stage({ files }) {
    return this.serial(async () => {
      if (!Array.isArray(files) || !files.length || files.length > 20)
        throw Error("A patch needs 1 to 20 files");
      let bytes = 0;
      const staged = [];
      for (const file of files) {
        if (typeof file?.content !== "string" || Buffer.byteLength(file.content) > 200000)
          throw Error("Patch file content is invalid or too large");
        bytes += Buffer.byteLength(file.content);
        if (bytes > 1000000 || staged.some((entry) => entry.path === file.path))
          throw Error("Patch exceeds total size or contains duplicate paths");
        const target = await safePath(this.source, file.path);
        const info = await exists(target);
        if (info && !info.isFile()) throw Error("Patch target must be a regular file");
        const original = info ? await readFile(target, "utf8") : null;
        staged.push({ path: file.path, content: file.content, original });
      }
      const id = randomUUID();
      const stage = {
        id,
        at: new Date().toISOString(),
        baseFingerprint: await fingerprint(this.source),
        files: staged,
      };
      await mkdir(join(this.base, id), { mode: 0o700 });
      await writeFile(join(this.base, id, "stage.json"), JSON.stringify(stage), {
        flag: "wx",
        mode: 0o400,
      });
      await this.receipt(id, "staged");
      return {
        id,
        status: "staged",
        files: staged.map((file) => file.path),
        baseFingerprint: stage.baseFingerprint,
      };
    });
  }
  async assertBase(stage) {
    if ((await fingerprint(this.source)) !== stage.baseFingerprint)
      throw Error("Patch is stale: source changed since staging");
    for (const file of stage.files) await safePath(this.source, file.path);
  }
  validate({ id }) {
    return this.serial(async () => {
      const { stage, status } = await this.read(id);
      if (!["staged", "validation-failed", "validated"].includes(status))
        throw Error("Patch cannot be validated in this state");
      await this.assertBase(stage);
      const snapshot = join(this.base, id, "snapshot-" + randomUUID());
      await mkdir(snapshot, { mode: 0o700 });
      const checks = [];
      try {
        for (const path of await sourceFiles(this.source)) {
          await mkdir(dirname(join(snapshot, path)), { recursive: true });
          await writeFile(join(snapshot, path), await readFile(join(this.source, path)));
        }
        for (const file of stage.files)
          await replace(await safePath(snapshot, file.path), file.content);
        const dependencies = await uiDependencies(this.source);
        await symlink(dependencies, join(snapshot, "node_modules"));
        for (const args of this.commands) {
          const check = await this.run(snapshot, dependencies, args);
          checks.push(check);
          if (check.exitCode !== 0) return await this.receipt(id, "validation-failed", { checks });
        }
        await this.assertBase(stage);
        return await this.receipt(id, "validated", { checks });
      } catch (error) {
        await this.receipt(id, "validation-failed", { checks, error: error.message });
        throw error;
      } finally {
        await rm(snapshot, { recursive: true, force: true });
      }
    });
  }
  async run(snapshot, dependencies, command) {
    if (!NPM) throw Error("npm must be available for UI validation");
    const args = ["--die-with-parent", "--unshare-all", "--new-session"];
    for (const path of ["/usr", "/bin", "/lib", "/lib64", NODE]) args.push("--ro-bind", path, path);
    args.push(
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      snapshot,
      snapshot,
      "--ro-bind",
      dependencies,
      dependencies,
      "--clearenv",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "PATH",
      NODE + "/bin:/usr/bin:/bin",
      "--setenv",
      "CI",
      "1",
      "--setenv",
      "NEXT_TELEMETRY_DISABLED",
      "1",
      "--setenv",
      "NODE_OPTIONS",
      "--max-old-space-size=512",
      "--chdir",
      snapshot,
      "--",
      process.execPath,
      NPM,
      ...command,
    );
    return await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "",
        bytes = 0;
      const append = (chunk) => {
        bytes += chunk.length;
        if (bytes <= 24000) output += chunk.toString();
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          command: "npm " + command.join(" "),
          exitCode,
          signal,
          output: output + (bytes > 24000 ? "\nOutput truncated" : ""),
        });
      });
    });
  }
  async restore(stage) {
    for (const file of stage.files) {
      const target = await safePath(this.source, file.path);
      const current = (await exists(target)) ? await readFile(target, "utf8") : null;
      if (current !== file.original && current !== file.content)
        throw Error("Recovery conflicts with an external edit: " + file.path);
    }
    for (const file of stage.files) {
      const target = await safePath(this.source, file.path);
      if (file.original === null) {
        if (await exists(target)) await unlink(target);
      } else await replace(target, file.original);
      const prefix = target.split("/").at(-1) + ".patch-";
      for (const name of await readdir(dirname(target))) {
        if (name.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(name.slice(prefix.length)))
          await unlink(join(dirname(target), name));
      }
    }
  }
  promote({ id }) {
    return this.serial(async () => {
      const { stage, status } = await this.read(id);
      if (status !== "validated") throw Error("Only a validated patch can be promoted");
      await this.assertBase(stage);
      await this.receipt(id, "applying");
      try {
        for (const file of stage.files)
          await replace(await safePath(this.source, file.path), file.content);
        return await this.receipt(id, "promoted", {
          sourceFingerprint: await fingerprint(this.source),
        });
      } catch (error) {
        await this.restore(stage);
        await this.receipt(id, "application-failed", { error: error.message });
        throw error;
      }
    });
  }
  rollback({ id }) {
    return this.serial(async () => {
      const { stage, status, receipts } = await this.read(id);
      if (status !== "promoted") throw Error("Only a promoted patch can be rolled back");
      if ((await fingerprint(this.source)) !== receipts.at(-1).sourceFingerprint)
        throw Error("Rollback is stale: source changed after promotion");
      await this.receipt(id, "rolling-back");
      await this.restore(stage);
      return await this.receipt(id, "rolled-back", {
        sourceFingerprint: await fingerprint(this.source),
      });
    });
  }
}

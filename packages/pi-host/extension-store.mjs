import { readFile, mkdir, writeFile, rename, readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WORK, atomicJson, ROOT } from "./security.mjs";
export class ExtensionStore {
  /**
   * `builtIn()` returns the host's own extension and tool names. An installed extension may
   * not reuse one, so it can never replace a host tool such as host_deploy or a whole host
   * extension such as host-dev (docs/SELF-EDIT.md audit, finding 6).
   */
  constructor(registry, base = ROOT + "/data", builtIn = () => ({ extensions: [], tools: [] })) {
    this.registry = registry;
    this.base = base;
    this.builtIn = builtIn;
    this.catalogue = [];
    this.skipped = [];
    this.chain = Promise.resolve();
  }
  async boot() {
    try {
      this.catalogue = JSON.parse(await readFile(this.base + "/extensions.json", "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // A tampered package still stops boot (integrity). A package that only clashes with a
    // newer built-in Mars name is skipped and reported, so a host update cannot be blocked by it.
    this.skipped = [];
    for (const row of this.catalogue) {
      try { await this.load(row); }
      catch (error) {
        if (!error.nameClash) throw error;
        this.skipped.push({ name: row.name, error: String(error.message).slice(0, 300) });
        console.error(`Extension ${row.name} not loaded: ${error.message}`);
      }
    }
  }
  async load(row) {
    const dir = join(this.base, "extensions", row.hash);
    const files = {};
    for (const name of ["manifest.json", "extension.mjs", "client.js"])
      files[name] = await readFile(join(dir, name), "utf8");
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    if (hash !== row.hash) throw Error("Installed extension hash mismatch");
    const module = await import(pathToFileURL(join(dir, "extension.mjs")).href + "?v=" + row.hash);
    const extension = module.default;
    if (
      !extension ||
      extension.name !== row.name ||
      !["tools", "tasks", "hooks", "sections", "wraps"].some(key => Array.isArray(extension[key]) && extension[key].length)
    )
      throw Error("Invalid native Pi extension");
    const host = this.builtIn();
    const clash = (message) => Object.assign(Error(message), { nameClash: true });
    if (host.extensions.includes(extension.name))
      throw clash(`Extension name "${extension.name}" belongs to Mars itself; choose another name`);
    for (const t of extension.tools || []) {
      if (host.tools.includes(t.name)) throw clash(`Invalid extension tool: "${t.name}" is a Mars tool; choose another name`);
      if (
        [
          "read",
          "write",
          "bash",
          "install_extension",
          "list_extensions",
          "ui_source_read",
          "ui_patch_stage",
          "ui_patch_validate",
          "ui_patch_promote",
          "ui_patch_rollback",
          "ui_patch_status",
          "discord_connection_status",
          "discord_list_channels",
          "discord_read_messages",
        ].includes(t.name) ||
        typeof t.name !== "string" ||
        typeof t.execute !== "function" ||
        !t.parameters
      )
        throw Error("Invalid extension tool");
    }
    // Keep new plugin schemas discoverable instead of adding every schema to every request.
    this.registry.install({ ...extension, marsPlugin: { title: row.title, description: row.description, version: row.version, kind: row.kind || "extension", hasUi: true }, tools: (extension.tools || []).map(t => ({ ...t, deferred: true })) });
    return extension;
  }
  install(target) {
    const task = this.chain.then(() => this.installOnce(target));
    this.chain = task.catch(() => {});
    return task;
  }
  async installOnce(target) {
    const dir = resolve(WORK, target);
    const files = {};
    for (const name of ["manifest.json", "extension.mjs", "client.js"]) {
      const path = join(dir, name);
      if (!(await lstat(path)).isFile()) throw Error("Package files must be regular files");
      files[name] = await readFile(path, "utf8");
      if (Buffer.byteLength(files[name]) > 100000) throw Error("Package file too large");
    }
    const manifest = JSON.parse(files["manifest.json"]);
    if (
      !/^[a-z][a-z0-9-]{0,50}$/.test(manifest.name) ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      typeof manifest.title !== "string"
    )
      throw Error("Invalid manifest name, version or title");
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const existing = this.catalogue.find((r) => r.hash === hash);
    if (existing)
      return {
        application: "applied",
        nativeRegistry: true,
        changed: false,
        ...existing,
        warnings: [],
      };
    if (["trial-host", "recovery-probe"].includes(manifest.name))
      throw Error("Reserved extension name");
    const frozen = join(this.base, "extensions", hash);
    await mkdir(frozen, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files))
      await writeFile(join(frozen, name), content, { mode: 0o400 });
    const row = {
      name: manifest.name,
      version: manifest.version,
      title: manifest.title,
      description: manifest.description || "",
      kind: manifest.kind === "mcp" ? "mcp" : "extension",
      hash,
      installedAt: new Date().toISOString(),
    };
    await this.load(row);
    const next = [...this.catalogue.filter((r) => r.name !== row.name), row];
    await atomicJson(this.base + "/extensions.json", next);
    this.catalogue = next;
    return { application: "applied", nativeRegistry: true, ...row, warnings: [] };
  }
  async ui(hash) {
    const row = this.catalogue.find((r) => r.hash === hash);
    if (!row) throw Error("Unknown installed extension");
    return await readFile(join(this.base, "extensions", hash, "client.js"), "utf8");
  }
}

import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";

export const APP = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(process.env.MARS_PI_ROOT || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "mars"));
export const WORK = join(ROOT, "workspace");
export const REPO = resolve(process.env.MARS_REPO_ROOT || join(APP, "../.."));
export const UI_DIR = resolve(process.env.MARS_UI_DIR || join(REPO, "apps/ui"));
export const NODE = dirname(dirname(process.execPath));
const require = createRequire(import.meta.url);
// npm workspaces hoist the SDK. Scratch scripts and installed plugins must resolve
// that real dependency tree, rather than a nonexistent package-local node_modules.
const sdkPath = require.resolve("@earendil-works/pi-durable");
export const DEPENDENCIES = sdkPath.slice(0, sdkPath.lastIndexOf("/node_modules/") + "/node_modules".length);
export const NPM_CLI = [join(NODE, "lib/node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "npm"), ...String(process.env.PATH || "").split(":").map(path => join(path, "npm"))].find(existsSync);
export const NPM = NPM_CLI ? realpathSync(NPM_CLI) : null;
function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error(name + " must be an integer from 1 to 65535");
  return value;
}
export const PORT = port("MARS_PI_PORT", 3081);
export const UI_PORT = port("MARS_UI_PORT", 3082);
export function publicOrigin(value = process.env.MARS_PUBLIC_ORIGIN) {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("MARS_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials");
  return url.origin;
}
export const PUBLIC_ORIGIN = publicOrigin();
export const ALLOWED_ORIGINS = String(process.env.MARS_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean).map(publicOrigin);
export function requestPolicy({ port = PORT, origin = PUBLIC_ORIGIN, aliases = ALLOWED_ORIGINS } = {}) {
  const local = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const origins = new Set([...local, ...(origin ? [origin] : []), ...aliases]);
  const configured = [...origins].map(value => new URL(value));
  const hosts = new Set([...origins].map(value => new URL(value).host));
  return {
    hostAllowed: host => hosts.has(host),
    originAllowed: (host, value) => !value || (origins.has(value) && new URL(value).host === host),
    secure: host => configured.some(url => url.host === host && url.protocol === "https:"),
    protocol: host => configured.some(url => url.host === host && url.protocol === "https:") ? "https" : "http",
  };
}
export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
export class Credentials {
  constructor(path) {
    this.path = path;
    this.chain = Promise.resolve();
  }
  async all() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  }
  async read(id) {
    return (await this.all())[id];
  }
  async list() {
    return Object.entries(await this.all()).map(([providerId, c]) => ({
      providerId,
      type: c.type,
    }));
  }
  modify(id, fn) {
    const task = this.chain.then(async () => {
      const all = await this.all();
      const value = await fn(all[id]);
      if (value !== undefined) {
        all[id] = value;
        await atomicJson(this.path, all);
      }
      return all[id];
    });
    this.chain = task.catch(() => {});
    return task;
  }
  delete(id) {
    const task = this.chain.then(async () => {
      const all = await this.all();
      delete all[id];
      await atomicJson(this.path, all);
    });
    this.chain = task.catch(() => {});
    return task;
  }
}

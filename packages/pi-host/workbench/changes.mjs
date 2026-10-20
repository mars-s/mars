import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveInside } from "./paths.mjs";

const run = promisify(execFile);

export const PATCH_CAP = 1024 * 1024;
export const UNTRACKED_CAP = 50;
const FILE_CAP = 2000;
const DEPTH = 3;
const MAX_REPOS = 100;
const MAX_DIRS = 5000;
const TIMEOUT_MS = 10_000;
const STATUS_BUFFER = 8 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules"]);

const fail = (message, status) => Object.assign(new Error(message), { status });

// Repo-local config is untrusted: it may name pagers, external diffs, textconv,
// fsmonitor hooks or clean filters, all of which run commands. These flags and
// the per-repo filter overrides below switch every one of them off.
const BASE = [
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.quotePath", "false"],
  ["color.ui", "false"],
  ["diff.noprefix", "false"],
  ["diff.mnemonicPrefix", "false"],
  ["diff.relative", "false"],
].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
const DIFF = ["--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];

const baseEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
};

async function pool(items, size, task) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(text) {
  const result = { branch: "", oid: "", ahead: 0, behind: 0, untracked: [], dirty: false };
  for (const record of text.split("\0")) {
    if (record.startsWith("# branch.head ")) result.branch = record.slice(14);
    else if (record.startsWith("# branch.oid ")) result.oid = record.slice(13);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(record.slice(12));
      if (match) [result.ahead, result.behind] = [Number(match[1]), Number(match[2])];
    } else if (record.startsWith("? ")) {
      result.untracked.push(record.slice(2));
      result.dirty = true;
    } else if (/^[12u] /.test(record)) result.dirty = true;
  }
  if (result.branch === "(detached)") result.branch = result.oid === "(initial)" ? "" : `detached at ${result.oid.slice(0, 7)}`;
  return result;
}

/** Parse `git diff --raw --numstat -z` (no renames) into path -> row. */
export function parseRawNumstat(text) {
  const rows = new Map();
  const row = (path) => rows.get(path) ?? rows.set(path, { path, status: "M", added: 0, removed: 0, binary: false }).get(path);
  const tokens = text.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith(":")) {
      const path = tokens[++index];
      if (path !== undefined) row(path).status = token.split(" ").at(-1)?.[0] || "M";
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token.replace(/^\n/, ""));
    if (!match) continue;
    const item = row(match[3]);
    item.binary = match[1] === "-";
    item.added = item.binary ? 0 : Number(match[1]);
    item.removed = item.binary ? 0 : Number(match[2]);
  }
  return rows;
}

/**
 * Read-only git change sets for workspace repositories (docs/WORKBENCH.md "Changes").
 * Every path goes through resolveInside; git runs via execFile with argument arrays.
 */
export function createChanges({ work }) {
  let probe;
  function available() {
    probe ??= run("git", ["--version"], { timeout: 5000, env: baseEnv() }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, reason: error.code === "ENOENT" ? "git was not found on the host." : `git did not start: ${error.message}` }),
    );
    return probe;
  }

  async function git(repo, args, { maxBuffer = STATUS_BUFFER, codes = [0], overflow = false } = {}) {
    try {
      const { stdout } = await run("git", [...BASE, ...repo.overrides, ...args], { cwd: repo.absolute, env: repo.env, timeout: TIMEOUT_MS, maxBuffer, encoding: "buffer" });
      return { stdout, overflowed: false };
    } catch (error) {
      if (error.code === "ENOENT") throw fail("git was not found on the host.", 503);
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        if (overflow) return { stdout: error.stdout, overflowed: true };
        throw fail("This repository has too many changes to show.", 413);
      }
      if (error.killed || error.signal) throw fail("git took longer than 10 seconds.", 504);
      if (codes.includes(error.code)) return { stdout: error.stdout, overflowed: false };
      const why = String(error.stderr ?? "").trim().split("\n").at(-1) || error.message;
      throw fail(`git failed: ${why}`.slice(0, 500), 500);
    }
  }

  /** Resolve `rel` to a repository root whose `.git` is a real directory inside the workspace. */
  async function openRepo(rel) {
    const target = await resolveInside(work, rel);
    const dotGit = await lstat(join(target.absolute, ".git")).catch(() => null);
    if (!dotGit?.isDirectory()) throw fail(`No git repository at ${target.relative || "the workspace root"}.`, 404);
    const repo = { ...target, overrides: [], env: { ...baseEnv(), GIT_DIR: join(target.absolute, ".git"), GIT_WORK_TREE: target.absolute } };
    const { stdout } = await git(repo, ["config", "--show-scope", "--includes", "--name-only", "--get-regexp", "^filter\\."], { codes: [1] });
    const drivers = new Set();
    for (const line of stdout.toString().split("\n")) {
      const [scope, key = ""] = line.split("\t");
      const match = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key);
      if (match && scope !== "global" && scope !== "system") drivers.add(match[1]);
    }
    for (const driver of drivers)
      repo.overrides.push(...["clean", "smudge", "process"].flatMap((key) => ["-c", `filter.${driver}.${key}=`]), "-c", `filter.${driver}.required=false`);
    return repo;
  }

  async function status(repo, untracked) {
    const { stdout } = await git(repo, ["status", "--porcelain=v2", "--branch", "-z", `--untracked-files=${untracked}`, "--ignore-submodules=all", "--no-renames"]);
    return parseStatus(stdout.toString());
  }

  async function repos() {
    const root = await resolveInside(work, "");
    const found = [];
    let dirs = 0;
    async function visit(absolute, rel, depth) {
      if (found.length >= MAX_REPOS || ++dirs > MAX_DIRS) return;
      const entries = (await readdir(absolute, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
      if (entries.some((entry) => entry.name === ".git" && entry.isDirectory())) found.push(rel);
      if (depth === DEPTH) return;
      for (const entry of entries)
        if (entry.isDirectory() && !SKIP.has(entry.name)) await visit(join(absolute, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
    await visit(root.absolute, "", 0);
    return pool(found, 8, async (path) => {
      try {
        const state = await status(await openRepo(path), "normal");
        return { path, branch: state.branch, ahead: state.ahead, behind: state.behind, dirty: state.dirty };
      } catch {
        return { path, branch: "", ahead: 0, behind: 0, dirty: false };
      }
    });
  }

  async function changes(rel) {
    const repo = await openRepo(rel);
    const state = await status(repo, "all");
    let base = "HEAD";
    if (state.oid === "(initial)") base = (await git(repo, ["hash-object", "-t", "tree", "/dev/null"])).stdout.toString().trim();
    const tracked = parseRawNumstat((await git(repo, ["diff", "--raw", "--numstat", "-z", ...DIFF, base, "--"])).stdout.toString());
    const diff = await git(repo, ["diff", "--patch", ...DIFF, "--src-prefix=a/", "--dst-prefix=b/", base, "--"], { maxBuffer: PATCH_CAP + 1, overflow: true });

    let truncated = state.untracked.length > UNTRACKED_CAP;
    let full = diff.overflowed;
    const chunks = [];
    let size = 0;
    const append = (buffer) => {
      if (full || size + buffer.length > PATCH_CAP) return void (full = true);
      chunks.push(buffer);
      size += buffer.length;
    };
    if (diff.overflowed) {
      const cut = diff.stdout.subarray(0, PATCH_CAP).lastIndexOf(10);
      chunks.push(diff.stdout.subarray(0, cut + 1));
      size = cut + 1;
    } else append(diff.stdout);

    const untracked = await pool(state.untracked.slice(0, UNTRACKED_CAP), 8, async (path) => {
      const file = { path, status: "?", added: 0, removed: 0, binary: false };
      const info = await lstat(join(repo.absolute, path)).catch(() => null);
      // A nested repository shows as `dir/`, and a file can vanish between status and diff.
      if (!info || info.isDirectory()) return { file, patch: null, skip: true };
      const withPatch = info.size <= PATCH_CAP;
      const { stdout, overflowed } = await git(repo, ["diff", "--no-index", "--numstat", ...(withPatch ? ["--patch", "--src-prefix=a/", "--dst-prefix=b/"] : []), ...DIFF, "--", "/dev/null", path], {
        maxBuffer: PATCH_CAP + 1024,
        codes: [1],
        overflow: true,
      });
      const counts = /^(\d+|-)\t(\d+|-)\t/.exec(stdout.toString("utf8", 0, 64));
      file.binary = counts?.[1] === "-";
      file.added = counts && !file.binary ? Number(counts[1]) : 0;
      const start = stdout.indexOf("diff --git ");
      return { file, patch: withPatch && !overflowed && start >= 0 ? stdout.subarray(start) : null, skip: false };
    });
    for (const item of untracked) {
      if (item.patch) append(item.patch);
      else if (!item.skip) truncated = true;
    }

    const files = [...tracked.values(), ...untracked.map((item) => item.file)].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (files.length > FILE_CAP) truncated = true;
    return { repo: repo.relative, branch: state.branch, files: files.slice(0, FILE_CAP), patch: Buffer.concat(chunks).toString("utf8"), truncated: truncated || full };
  }

  return {
    available,
    async handle(req, res, url, route, { send }) {
      if (req.method !== "GET" || (route !== "repos" && route !== "changes")) return false;
      const ready = await available();
      if (!ready.ok) return send(res, 503, { error: ready.reason }), true;
      if (route === "repos") send(res, 200, { repos: await repos() });
      else send(res, 200, await changes(url.searchParams.get("repo") ?? ""));
      return true;
    },
  };
}

import { constants } from "node:fs";
import { open, opendir, lstat, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { openInside, resolveInside } from "./paths.mjs";

// docs/WORKBENCH.md "Files". Read-only views of the Pi workspace.
export const FILE_LIMITS = {
  entries: 2000,
  text: 2 * 1024 * 1024,
  raw: 20 * 1024 * 1024,
  results: 200,
  searchMs: 3000,
  query: 200,
  sniff: 8192,
};
const SKIP = new Set(["node_modules", ".git"]);
const fail = (message, status) => Object.assign(new Error(message), { status });

/** Image type from the first bytes. The extension is never consulted. SVG stays text: it can carry script. */
export function sniffImage(head) {
  const ascii = (start, end) => head.subarray(start, end).toString("latin1");
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "";
}

function looksBinary(head) {
  if (head.includes(0)) return true;
  try {
    // stream: true tolerates a character cut off at the end of the sample.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return false;
  } catch {
    return true;
  }
}

/** Host errors become plain messages; never echo an absolute host path. */
function publicError(error) {
  if (error.status) return error;
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return fail("That file or folder does not exist.", 404);
  if (error.code === "EACCES" || error.code === "EPERM") return fail("The host is not allowed to read that path.", 403);
  if (error.code === "ELOOP") return fail("Path must stay inside the workspace", 403);
  return fail("The host could not read that path.", 500);
}

async function readFully(handle, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function score(name, path, needle) {
  const haystack = needle.includes("/") ? path.toLowerCase() : name.toLowerCase();
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  return haystack.includes(needle) ? 2 : -1;
}

/**
 * Breadth-first file name search under `root`. Never descends `node_modules`, `.git` or
 * symlinks, so it cannot leave the root. Stops at `limit` matches or after `budgetMs`.
 */
export async function searchFiles(root, query, { limit = FILE_LIMITS.results, budgetMs = FILE_LIMITS.searchMs } = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [], truncated: false, timedOut: false };
  const base = await realpath(root);
  const deadline = Date.now() + budgetMs;
  const queue = [""];
  const hits = [];
  let truncated = false;
  let timedOut = false;
  walk: for (const rel of queue) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    let dir;
    try {
      dir = await opendir(rel ? join(base, rel) : base);
    } catch {
      continue;
    }
    for await (const entry of dir) {
      if (Date.now() > deadline) {
        timedOut = true;
        break walk;
      }
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const rank = score(entry.name, path, needle);
      if (rank >= 0) {
        hits.push({ path, type: entry.isDirectory() ? "dir" : "file", rank });
        if (hits.length >= limit) {
          truncated = true;
          break walk;
        }
      }
      if (entry.isDirectory() && !SKIP.has(entry.name)) queue.push(path);
    }
  }
  hits.sort((a, b) => a.rank - b.rank || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  return { results: hits.map(({ path, type }) => ({ path, type })), truncated, timedOut };
}

export function createFiles({ work }) {
  async function linkTarget(rel) {
    try {
      const target = await resolveInside(work, rel);
      const info = await stat(target.absolute);
      return { type: info.isDirectory() ? "dir" : "file", path: target.relative };
    } catch (error) {
      return { type: error.status === 403 ? "outside" : "missing" };
    }
  }

  async function listing(rel) {
    const dir = await resolveInside(work, rel);
    if (!(await stat(dir.absolute)).isDirectory()) throw fail("That path is a file, not a folder.", 400);
    const dirents = [];
    let truncated = false;
    for await (const entry of await opendir(dir.absolute)) {
      if (dirents.length === FILE_LIMITS.entries) {
        truncated = true;
        break;
      }
      dirents.push(entry);
    }
    const rows = await Promise.all(
      dirents.map(async ({ name }) => {
        const info = await lstat(join(dir.absolute, name)).catch(() => null);
        if (!info) return null;
        const row = {
          name,
          type: info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file",
          size: info.isFile() ? info.size : 0,
          modified: info.mtimeMs,
          hidden: name.startsWith("."),
        };
        if (row.type === "link") row.target = await linkTarget(dir.relative ? `${dir.relative}/${name}` : name);
        return row;
      }),
    );
    const folder = (row) => row.type === "dir" || row.target?.type === "dir";
    const entries = rows
      .filter(Boolean)
      .sort((a, b) => Number(folder(b)) - Number(folder(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { path: dir.relative, entries, truncated };
  }

  async function file(rel) {
    const { handle, info, target } = await openInside(work, rel);
    try {
      const base = { path: target.relative, size: info.size, modified: info.mtimeMs };
      const head = await readFully(handle, Math.min(info.size, FILE_LIMITS.sniff));
      const mime = sniffImage(head);
      if (mime) return { ...base, kind: "image", mime };
      if (looksBinary(head)) return { ...base, kind: "binary" };
      const bytes = await readFully(handle, Math.min(info.size, FILE_LIMITS.text));
      // StringDecoder holds back a trailing partial character instead of emitting U+FFFD.
      return { ...base, kind: "text", text: new StringDecoder("utf8").write(bytes), truncated: info.size > FILE_LIMITS.text };
    } finally {
      await handle.close();
    }
  }

  async function raw(rel, res) {
    const { handle, info, target } = await openInside(work, rel);
    let streaming = false;
    try {
      const mime = sniffImage(await readFully(handle, Math.min(info.size, 16)));
      if (!mime) throw fail("Only images can be shown directly.", 415);
      if (info.size > FILE_LIMITS.raw) throw fail("That image is larger than 20 MiB.", 413);
      res.writeHead(200, {
        "content-type": mime,
        "content-length": info.size,
        "cache-control": "no-store",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      streaming = true;
      await pipeline(handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1), autoClose: true }), res);
    } finally {
      if (!streaming) await handle.close();
    }
  }

  return {
    async handle(req, res, url, route, { send }) {
      if (req.method !== "GET" || !["files", "file", "raw", "search"].includes(route)) return false;
      const rel = url.searchParams.get("path") ?? "";
      try {
        if (route === "files") send(res, 200, await listing(rel));
        else if (route === "file") send(res, 200, await file(rel));
        else if (route === "raw") await raw(rel, res);
        else {
          const q = (url.searchParams.get("q") ?? "").slice(0, FILE_LIMITS.query);
          send(res, 200, { query: q, ...(await searchFiles(work, q)) });
        }
      } catch (failure) {
        if (res.headersSent) throw failure;
        const error = publicError(failure);
        send(res, error.status, { error: error.message });
      }
      return true;
    },
  };
}

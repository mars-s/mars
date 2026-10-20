import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInside } from "./paths.mjs";

// Pages (docs/WORKBENCH.md "Pages"): Markdown files in WORK/pages, saved atomically.
const NAME = /^[a-z0-9-]{1,64}$/;
const MAX_TEXT = 1024 * 1024;
const TITLE_SCAN = 64 * 1024;
const MAX_PAGES = 2000;
const fail = (message, status, extra = {}) => Object.assign(new Error(message), { status, extra });

export const pageTitle = (text, name) => /^# +(.+?)\s*#*\s*$/m.exec(text)?.[1].trim() || name;

async function head(path) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(TITLE_SCAN);
    const { bytesRead } = await file.read(buffer, 0, TITLE_SCAN, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export function createPages({ work }) {
  const dir = () => resolveInside(work, "pages");
  const file = (name) => {
    if (typeof name !== "string" || !NAME.test(name)) throw fail("Page names use a to z, 0 to 9 and hyphens, up to 64 characters.", 400);
    return resolveInside(work, `pages/${name}.md`);
  };
  // One write at a time per host keeps the stale check and the rename a single step.
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };

  async function list() {
    const { absolute } = await dir();
    let names;
    try {
      names = await readdir(absolute);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const pages = [];
    for (const entry of names) {
      if (!entry.endsWith(".md") || !NAME.test(entry.slice(0, -3))) continue;
      const path = join(absolute, entry);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const name = entry.slice(0, -3);
      pages.push({ name, title: pageTitle(await head(path), name), modified: info.mtimeMs, size: info.size });
      if (pages.length >= MAX_PAGES) break;
    }
    return pages.sort((a, b) => b.modified - a.modified);
  }

  async function read(name) {
    const { absolute } = await file(name);
    const info = await stat(absolute).catch((error) => {
      throw error.code === "ENOENT" ? fail("That page does not exist.", 404) : error;
    });
    if (!info.isFile()) throw fail("That page does not exist.", 404);
    if (info.size > MAX_TEXT) throw fail("This page is larger than 1 MiB.", 413);
    return { name, text: await readFile(absolute, "utf8"), modified: info.mtimeMs };
  }

  async function writeTemp(folder, text) {
    const temp = join(folder, `.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    return temp;
  }

  /** Link the temp file to a name that must not exist yet; false when it does. */
  async function createExclusive(temp, target) {
    try {
      await link(temp, target);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  const saved = async (name, absolute, text) => ({ name, title: pageTitle(text, name), modified: (await stat(absolute)).mtimeMs, size: Buffer.byteLength(text) });

  async function save({ name, text, baseModified }) {
    if (typeof text !== "string") throw fail("Page text must be a string.", 400);
    if (Buffer.byteLength(text) > MAX_TEXT) throw fail("Pages are limited to 1 MiB.", 413);
    if (baseModified !== undefined && (typeof baseModified !== "number" || !Number.isFinite(baseModified))) throw fail("baseModified must be a number.", 400);
    if (name !== undefined) await file(name);
    return serial(async () => {
      await mkdir((await dir()).absolute, { recursive: true });
      const folder = (await dir()).absolute;
      if (name === undefined) {
        for (let n = 1; n <= 1000; n++) {
          const candidate = n === 1 ? "untitled" : `untitled-${n}`;
          const { absolute } = await file(candidate);
          if (await createExclusive(await writeTemp(folder, text), absolute)) return { created: true, page: await saved(candidate, absolute, text) };
        }
        throw fail("Too many untitled pages. Rename some first.", 409);
      }
      const { absolute } = await file(name);
      const current = await lstat(absolute).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current && !current.isFile()) throw fail("That page name is taken by something that is not a page.", 409);
      if (!current) {
        if (baseModified !== undefined) throw fail("This page was deleted elsewhere.", 409, { modified: 0 });
        if (!(await createExclusive(await writeTemp(folder, text), absolute))) throw fail("A page with this name was just created elsewhere.", 409, { modified: (await stat(absolute)).mtimeMs });
        return { created: true, page: await saved(name, absolute, text) };
      }
      if (baseModified !== current.mtimeMs) throw fail("This page changed elsewhere since you opened it.", 409, { modified: current.mtimeMs });
      const temp = await writeTemp(folder, text);
      try {
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      return { created: false, page: await saved(name, absolute, text) };
    });
  }

  async function respond(res, send, task) {
    try {
      await task();
    } catch (error) {
      if (!error.status) throw error;
      send(res, error.status, { error: error.message, ...error.extra });
    }
  }

  return {
    list,
    async handle(req, res, url, route, { send, jsonBody }) {
      if (route === "pages" && req.method === "GET") {
        await respond(res, send, async () => send(res, 200, { pages: await list() }));
        return true;
      }
      if (route === "pages" && req.method === "POST") {
        await respond(res, send, async () => {
          const body = await jsonBody(req).catch((error) => {
            throw /too large/i.test(error.message) ? fail("Pages are limited to 1 MiB.", 413) : fail("Send the page as JSON.", 400);
          });
          const { created, page } = await save({ name: body.name, text: body.text, baseModified: body.baseModified });
          send(res, created ? 201 : 200, page);
        });
        return true;
      }
      if (route.startsWith("pages/") && req.method === "GET") {
        await respond(res, send, async () => send(res, 200, await read(route.slice("pages/".length))));
        return true;
      }
      return false;
    },
  };
}

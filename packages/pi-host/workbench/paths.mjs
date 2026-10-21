import { constants } from "node:fs";
import { lstat, open, readlink, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Resolve `rel` inside `root` (docs/WORKBENCH.md "Roots and paths"). Rejects absolute
 * paths, NUL bytes and `..` segments, then checks the realpath of the target (or of its
 * nearest existing ancestor) so a symlink cannot lead outside the root.
 */
export async function resolveInside(root, rel = "") {
  if (typeof rel !== "string" || rel.length > 4096) throw fail("Invalid path");
  if (rel.includes("\0")) throw fail("Invalid path");
  const clean = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (isAbsolute(clean) || clean.split(/[\\/]/).some((part) => part === "..")) throw fail("Path must stay inside the workspace", 403);
  const realRoot = await realpath(root);
  const target = clean ? resolve(realRoot, clean) : realRoot;
  let probe = target;
  for (;;) {
    try {
      await lstat(probe);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const real = await realpath(probe);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw fail("Path must stay inside the workspace", 403);
  const tail = relative(probe, target);
  return { absolute: tail ? join(real, tail) : real, relative: relative(realRoot, tail ? join(real, tail) : real).split(sep).join("/") };
}

/**
 * Is the file behind `handle` really at `relative` inside `root`? On Linux the kernel
 * names the open file (/proc/self/fd), which no rename can fake. Elsewhere each path
 * component is checked with lstat to be a real directory, never a symlink, and the last
 * one must be the very file that is open (same device and inode). A swap mid-walk is
 * caught because a component would be a symlink or the inode would differ.
 */
export async function handleInside(root, relativePath, handle) {
  const realRoot = await realpath(root);
  const info = await handle.stat();
  if (process.platform === "linux") {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => "");
    return actual === join(realRoot, relativePath) && (actual === realRoot || actual.startsWith(realRoot + sep));
  }
  // Without openat, the last lstat re-resolves the folders, so one walk can be fooled by
  // a flip at that instant. Two walks must agree on every folder's inode and end on the
  // open file; a race has to win four times in a row. Linux above has no such window.
  const parts = relativePath.split("/").filter(Boolean);
  const walk = async () => {
    const seen = [];
    let current = realRoot;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const entry = await lstat(current).catch(() => null);
      if (!entry || entry.isSymbolicLink()) return null;
      if (index < parts.length - 1 ? !entry.isDirectory() : entry.dev !== info.dev || entry.ino !== info.ino) return null;
      seen.push(`${entry.dev}:${entry.ino}`);
    }
    return seen.join("/");
  };
  const first = await walk();
  return first !== null && first === (await walk());
}

/**
 * Open a regular file inside `root` without following a swapped-in symlink or blocking
 * on a FIFO. `realpath` and `open` are separate steps, so a folder in the path could be
 * swapped for a symlink between them; after opening, handleInside proves the open file
 * is the one inside the workspace, or the read is refused.
 */
export async function openInside(root, rel) {
  const target = await resolveInside(root, rel);
  const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch((error) => {
    throw error.code === "ELOOP" ? fail("Only regular files can be viewed.", 400) : error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail(info.isDirectory() ? "That path is a folder, not a file." : "Only regular files can be viewed.", 400);
    if (!(await handleInside(root, target.relative, handle))) throw fail("The file changed while it was being opened. Try again.", 409);
    return { handle, info, target };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Create `relativePath` (which must not exist) inside `root` with `data`, mode 600. If
 * the folder was swapped while writing, the bytes are wiped through the handle, so the
 * text never stays readable outside the workspace, and the save is refused.
 */
export async function writeNewInside(root, relativePath, data) {
  const target = await resolveInside(root, relativePath);
  const handle = await open(target.absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
    if (!(await handleInside(root, target.relative, handle))) {
      // Wipe through the handle (it is the real file wherever it landed), then remove
      // the now-empty name if it is still reachable. Only an empty, mode-600 file can
      // be left behind on macOS, never the text.
      await handle.truncate(0);
      await unlink(target.absolute).catch(() => undefined);
      throw fail("The folder changed during the save. Try again.", 409);
    }
    return target.absolute;
  } finally {
    await handle.close();
  }
}

import { lstat, realpath } from "node:fs/promises";
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

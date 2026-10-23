import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

// Shortest value treated as a secret. It is longer than the mark, so redacting a file
// in place never needs more room than the original.
const MIN = 12;
const MARK = "[redacted]";
const MARK_BYTES = Buffer.from(MARK);
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|KEY/i;
const SECRET_FIELD = /token|secret|password|key|access|refresh/i;

async function quiet(path) {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

/** Every secret the host holds: owner token, web token, OAuth and API credentials, secret-named env values. */
export async function hostSecrets({ dataDir, env = process.env } = {}) {
  const found = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    // Paths such as MARS_PI_TOKEN_FILE name a secret but are not one.
    if (trimmed.length >= MIN && !trimmed.startsWith("/")) found.add(trimmed);
  };
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name)) add(value);
  if (dataDir) {
    add(await quiet(join(dataDir, "web-token")));
    for (const name of ["auth.json", "connections.json", "connector-secrets.json"]) {
      const text = await quiet(join(dataDir, name));
      if (!text) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      const walk = (value, secret) => {
        if (typeof value === "string") { if (secret) add(value); return; }
        if (Array.isArray(value)) { for (const item of value) walk(item, secret); return; }
        if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, secret || SECRET_FIELD.test(key));
      };
      walk(parsed, false);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

export function redactText(text, secrets) {
  if (typeof text !== "string") return text;
  for (const secret of secrets) if (secret.length >= MIN && text.includes(secret)) text = text.split(secret).join(MARK);
  return text;
}

/**
 * Replace every secret in a file, in place, reading it in chunks. A tail as long as the
 * longest secret is carried between chunks, so a secret split across two writes is still
 * found. Files without a secret are only read. Returns the number of replacements.
 */
export async function redactFile(path, secrets, chunkBytes = 1 << 20) {
  const needles = secrets.filter((secret) => secret.length >= MIN).map((secret) => Buffer.from(secret)).sort((a, b) => b.length - a.length);
  if (!needles.length) return 0;
  const longest = needles[0].length;
  const file = await open(path, "r+");
  const chunk = Buffer.alloc(Math.max(chunkBytes, longest));
  let readAt = 0;
  let writeAt = 0;
  let pending = Buffer.alloc(0);
  let count = 0;
  try {
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, readAt);
      readAt += bytesRead;
      const final = bytesRead === 0;
      const buffer = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      // A match starting before limit lies wholly inside buffer.
      const limit = final ? buffer.length : Math.max(0, buffer.length - (longest - 1));
      const next = needles.map(() => -2);
      const parts = [];
      let position = 0;
      for (;;) {
        let best = -1;
        let bestNeedle = null;
        needles.forEach((needle, index) => {
          if (next[index] !== -1 && next[index] < position) next[index] = buffer.indexOf(needle, position);
          const at = next[index];
          if (at !== -1 && at < limit && (best === -1 || at < best)) { best = at; bestNeedle = needle; }
        });
        if (best === -1) break;
        parts.push(buffer.subarray(position, best), MARK_BYTES);
        position = best + bestNeedle.length;
        count++;
      }
      const cut = Math.max(position, limit);
      parts.push(buffer.subarray(position, cut));
      const out = Buffer.concat(parts);
      if (count && out.length) await file.write(out, 0, out.length, writeAt);
      writeAt += out.length;
      pending = Buffer.from(buffer.subarray(cut));
      if (final) break;
    }
    if (count) await file.truncate(writeAt);
  } finally { await file.close(); }
  return count;
}

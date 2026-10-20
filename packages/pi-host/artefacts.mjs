import { mkdir, open, stat, copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ID = /^[0-9a-f-]{36}$/;
export function createArtefacts({ root }) {
  const directory = join(root, "artefacts");
  const path = (id) => {
    if (!ID.test(id)) throw Error("Invalid artefact ID");
    return join(directory, id);
  };
  async function allocate() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const file = await open(path(id), "wx", 0o600);
    return { id, file };
  }
  async function describe(id) {
    const info = await stat(path(id));
    return { id, bytes: info.size };
  }
  async function read(id, { offset = 0, limit = 4096 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16384)
      throw Error("Invalid artefact byte range");
    const file = await open(path(id), "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await file.read(buffer, 0, limit, offset);
      const { size } = await file.stat();
      return { id, offset, nextOffset: offset + bytesRead, bytes: size, text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: offset + bytesRead < size };
    } finally { await file.close(); }
  }
  async function search(id, { query, offset = 0, limit = 20 } = {}) {
    if (typeof query !== "string" || !query || query.length > 1024 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw Error("Invalid artefact search");
    // Fixed-size chunks bound memory even when the output has no newline.
    const file = await open(path(id), "r");
    const matches = [];
    let position = offset;
    let carry = Buffer.alloc(0);
    const needle = Buffer.from(query);
    try {
      const buffer = Buffer.alloc(16384);
      while (matches.length < limit) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
        const base = position - carry.length;
        let index = 0;
        while ((index = chunk.indexOf(needle, index)) !== -1 && matches.length < limit) {
          matches.push({ offset: base + index, text: chunk.subarray(Math.max(0, index - 80), Math.min(chunk.length, index + needle.length + 80)).toString("utf8") });
          index += needle.length;
        }
        position += bytesRead;
        carry = chunk.subarray(Math.max(0, chunk.length - needle.length + 1));
      }
      return { id, matches, nextOffset: matches.length === limit ? matches.at(-1).offset + needle.length : position };
    } finally { await file.close(); }
  }
  async function snapshot(source) {
    const { id, file } = await allocate();
    await file.close();
    await copyFile(source, path(id));
    await chmod(path(id), 0o600);
    return describe(id);
  }
  return { allocate, describe, read, search, snapshot, path, get: describe };
}

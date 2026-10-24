// Project instructions (docs/PROJECTS.md): the AGENTS.md and CLAUDE.md of the repository a
// conversation works in are added to its prompt, as Claude Code and Codex do. The repository is
// remembered per conversation in a native document: set by project_open, or found automatically
// from the first tool call that names a path inside a git repository.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open as openFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable';

const run = promisify(execFile);
export const ProjectDoc = defineDoc({ kind: 'mars.project', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ root: '' }) });
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const FILE_MAX = 12000;
// Bytes read at most: enough for FILE_MAX characters of any UTF-8 text.
const READ_MAX = FILE_MAX * 4;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** The git top level containing `path` (a file or folder), or '' when it is not in a repository. */
export async function gitRoot(path) {
  let dir = path;
  try {
    if (!(await stat(dir)).isDirectory()) dir = resolve(dir, '..');
  } catch {
    dir = resolve(dir, '..');
    try { if (!(await stat(dir)).isDirectory()) return ''; } catch { return ''; }
  }
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** The folder a tool call works in: cwd, path, or a leading `cd <dir>` in a shell command. */
export function pathOfCall(name, args, base) {
  if (!args || typeof args !== 'object') return '';
  const expand = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const text = value.trim().replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(text) ? text : resolve(base, text);
  };
  if (typeof args.cwd === 'string') return expand(args.cwd);
  if (typeof args.command === 'string') {
    const cd = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(args.command);
    if (cd) return expand(cd[2] ?? cd[3] ?? cd[4]);
  }
  if (typeof args.path === 'string' && /^(read|write|edit|host_read|host_write|host_edit|host_view_image)$/.test(name)) return expand(args.path);
  return '';
}

export function createProjects({ harness, work, context }) {
  const cache = new Map();
  /**
   * The text of one instruction file, or undefined. Only a regular file whose real path stays
   * inside the repository is read (a link to /proc/self/environ or ~/.ssh is not), and only its
   * first READ_MAX bytes, so a FIFO, a device or a huge file never hangs or floods the host.
   */
  async function instructionFile(root, name) {
    let real;
    try {
      real = await realpath(join(root, name));
      if (!real.startsWith((await realpath(root)) + sep)) return undefined;
    } catch { return undefined; }
    let fh;
    // O_NONBLOCK: opening a FIFO with no writer returns at once instead of waiting for one.
    try { fh = await openFile(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { return undefined; }
    try {
      const info = await fh.stat();
      if (!info.isFile()) return undefined;
      const hit = cache.get(real);
      if (hit && hit.mtime === info.mtimeMs && hit.size === info.size) return hit.text;
      const buffer = Buffer.alloc(Math.min(info.size, READ_MAX));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await fh.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const raw = buffer.subarray(0, length).toString('utf8');
      const cut = raw.length > FILE_MAX || info.size > READ_MAX;
      const text = cut ? raw.slice(0, FILE_MAX) + `\n\n(Cut at ${FILE_MAX} characters; read the file for the rest.)` : raw;
      cache.set(real, { mtime: info.mtimeMs, size: info.size, text });
      return text;
    } finally {
      await fh.close().catch(() => {});
    }
  }
  /** The instruction files of a repository root, in order, as [name, text]. */
  async function instructions(root) {
    const out = [];
    for (const name of INSTRUCTION_FILES) {
      const text = await instructionFile(root, name);
      if (text?.trim()) out.push([name, text.trim()]);
    }
    return out;
  }
  async function render(root) {
    if (!root) return undefined;
    const files = await instructions(root);
    const head = `## Project\n\nThis conversation works in the repository ${root}. Follow its instructions below; they override general habits. Call project_open to switch repository.`;
    if (!files.length) return `${head}\n\n(It has no AGENTS.md or CLAUDE.md.)`;
    return [head, ...files.map(([name, text]) => `### ${name}\n\n${text}`)].join('\n\n');
  }
  async function open(conversationId, path) {
    const absolute = isAbsolute(path) ? path : resolve(work, path.replace(/^~(?=\/|$)/, homedir()));
    const root = (await gitRoot(absolute)) || ((await stat(absolute).then((s) => s.isDirectory(), () => false)) ? absolute : '');
    if (!root) throw fail(`${path} is not a folder on this machine`);
    await harness().commit(async (tx) => { (await tx.doc(ProjectDoc, conversationId)).root = root; }, context);
    return { root, instructions: (await instructions(root)).map(([name]) => name) };
  }
  /** Remember the repository of the first tool call that names a path inside one. Never switches. */
  async function notice(conversationId, name, args) {
    const current = await harness().snapshot(ProjectDoc, conversationId, context);
    if (current?.root) return;
    const path = pathOfCall(name, args, work);
    if (!path) return;
    const root = await gitRoot(path);
    if (!root) return;
    await harness().commit(async (tx) => {
      const doc = await tx.doc(ProjectDoc, conversationId);
      if (!doc.root) doc.root = root;
    }, context);
  }
  return { render, open, notice, instructions };
}

export function createProjectExtension({ projects }) {
  return defineExtension({
    name: 'mars-project',
    sections: [
      section('project', async (input, ctx) => projects.render((await input.read.snapshot(ProjectDoc, input.conversationId, ctx))?.root), { tag: false }),
    ],
    hooks: [{
      task: 'pi.tool',
      handlers: {
        // Never delay or change the call: the repository is noted after it, in its own commit.
        afterTool: (call, _result, api) => {
          const conversationId = api.conversationId;
          setImmediate(() => { projects.notice(conversationId, call.name, call.arguments).catch(() => {}); });
          return undefined;
        },
      },
    }],
    tools: [
      defineTool({
        name: 'project_open',
        description: `Set the repository this conversation works in, so its AGENTS.md and CLAUDE.md guide you.
Use it before working in a repository other than the one already shown in the Project section, or when there is no Project section yet. Pass any path inside the repository; its git top level is used. The instructions appear in your prompt from the next step. It returns the root and which instruction files it has.
Example: await tools.project_open({ path: "/home/bot/ChatGPT/mars" })`,
        parameters: Type.Object({
          path: Type.String({ minLength: 1, maxLength: 1000, description: 'A folder or file inside the repository, absolute or relative to the workspace, e.g. "/home/bot/projects/site".' }),
        }),
        structuredOutputSchema: Type.Object({
          root: Type.String({ description: 'The repository root now used for this conversation.' }),
          instructions: Type.Array(Type.String(), { description: 'Instruction files found at the root, e.g. ["AGENTS.md"].' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args, api) => {
          const value = await projects.open(api.conversationId, args.path);
          return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
        },
      }),
    ],
  });
}

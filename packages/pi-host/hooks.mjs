// Session start hooks (docs/AGENTS-AND-HOOKS.md), a small safe subset of Claude Code hooks.
// Markdown files added to the prompt of every conversation: Mars's own
// <workspace>/hooks/session-start/*.md, and Claude Code plugin hooks.json SessionStart
// entries whose command only cats a Markdown file inside the plugin (optionally behind a
// "grep -s 'literal' file >/dev/null ||" off switch). Mars reads that file itself and never
// runs a hook command. Every other hook is ignored and reported.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { defineExtension, section } from '@earendil-works/pi-durable';
import { findPlugins } from './agents.mjs';
import { nativeTitleDoc } from './orchestration.mjs';

const FILE_MAX = 8000;
const SECTION_MAX = 16000;
// A double-quoted, single-quoted or bare shell word with no expansion beyond known variables.
const WORD = String.raw`(?:"([^"\`\\]+)"|'([^']+)'|([^\s"'\`\\;&|<>()]+))`;
const CAT = new RegExp(`^cat\\s+${WORD}$`);
const GREP = new RegExp(`^grep\\s+-(?:s|q|sq|qs)\\s+${WORD}\\s+${WORD}(?:\\s*>\\s*/dev/null)?(?:\\s+2>\\s*/dev/null|\\s+2>&1)?$`);
const word = (match, at) => match[at] !== undefined ? { text: match[at], literal: false } : match[at + 1] !== undefined ? { text: match[at + 1], literal: true } : { text: match[at + 2], literal: false };

function expand({ text, literal }, vars) {
  if (literal) return text;
  const out = text.replace(/^~(?=\/)/, vars.HOME).replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => vars[a || b] ?? all);
  return out.includes('$') ? undefined : out;
}

/**
 * Parse one hook command. Returns { file, guard? } when it is exactly
 * `[grep -s 'literal' "<file>" >/dev/null ||] cat "<plugin>/<file>.md"`, else { reason }.
 */
export function parseCatCommand(command, { pluginRoot, home }) {
  const vars = { CLAUDE_PLUGIN_ROOT: pluginRoot, HOME: home };
  const parts = String(command || '').trim().split(/\s*\|\|\s*/);
  if (parts.length > 2) return { reason: 'command does more than read one Markdown file' };
  const cat = CAT.exec(parts.at(-1));
  if (!cat) return { reason: 'command is not a plain cat of a Markdown file' };
  const file = expand(word(cat, 1), vars);
  if (!file || !file.startsWith('/') || !/\.md$/i.test(file)) return { reason: 'command does not cat a Markdown file in the plugin' };
  if (parts.length === 1) return { file };
  const grep = GREP.exec(parts[0]);
  if (!grep) return { reason: 'command runs something before cat other than an off switch' };
  const pattern = word(grep, 1).text;
  const guardFile = expand(word(grep, 4), vars);
  const anchored = pattern.startsWith('^');
  const literal = anchored ? pattern.slice(1) : pattern;
  if (!literal || /[\\.*+?()[\]{}|$]/.test(literal) || !guardFile?.startsWith('/')) return { reason: 'off switch is not a plain text match in a file' };
  return { file, guard: { file: guardFile, text: literal, anchored } };
}

/** The SessionStart file hooks of one plugin's hooks.json, and the ignored ones. */
export async function pluginSessionStart(plugin, home) {
  const source = 'plugin:' + plugin.name;
  let json;
  try { json = JSON.parse(await readFile(join(plugin.root, 'hooks', 'hooks.json'), 'utf8')); } catch (error) {
    return { files: [], ignored: error.code === 'ENOENT' ? [] : [{ source, reason: 'hooks/hooks.json is not valid JSON' }] };
  }
  const files = [];
  const ignored = [];
  for (const [event, groups] of Object.entries(json?.hooks || {})) {
    if (event !== 'SessionStart') { ignored.push({ source, reason: `${event} hooks are not supported` }); continue; }
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = typeof group?.matcher === 'string' ? group.matcher.trim() : '';
      if (matcher && matcher !== '*' && !matcher.split('|').map((m) => m.trim()).includes('startup')) { ignored.push({ source, reason: `SessionStart matcher "${matcher}" does not include startup` }); continue; }
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (hook?.type !== 'command' || hook.async === true) { ignored.push({ source, reason: 'only synchronous command hooks are read' }); continue; }
        const parsed = parseCatCommand(hook.command, { pluginRoot: plugin.root, home });
        if (parsed.reason) { ignored.push({ source, reason: parsed.reason }); continue; }
        let real;
        try {
          real = await realpath(parsed.file);
          const root = await realpath(plugin.root);
          if (!real.startsWith(root + sep)) throw new Error('outside');
        } catch { ignored.push({ source, reason: 'the Markdown file is missing or outside the plugin' }); continue; }
        if (parsed.guard) {
          const guard = await readFile(parsed.guard.file, 'utf8').catch(() => '');
          const off = guard.split(/\r?\n/).some((line) => parsed.guard.anchored ? line.startsWith(parsed.guard.text) : line.includes(parsed.guard.text));
          if (off) { ignored.push({ source, reason: `turned off by "${parsed.guard.text}" in ${parsed.guard.file}` }); continue; }
        }
        files.push({ source, path: real });
      }
    }
  }
  return { files, ignored };
}

/** Mars's own session start files, then plugin ones, read at most every cacheMs. */
export function createSessionHooks({ work, home = process.env.HOME || homedir(), plugins = findPlugins, cacheMs = 15000 }) {
  let cache;
  async function scan() {
    if (cache && Date.now() - cache.at < cacheMs) return cache.report;
    const files = [];
    const ignored = [];
    const own = join(work, 'hooks', 'session-start');
    let names = [];
    try { names = (await readdir(own)).filter((n) => !n.startsWith('.') && /\.md$/i.test(n)).sort(); } catch { /* none */ }
    for (const name of names) {
      const path = join(own, name);
      if ((await stat(path).catch(() => null))?.isFile()) files.push({ source: 'mars', path });
    }
    for (const plugin of await plugins({ home })) {
      const found = await pluginSessionStart(plugin, home);
      files.push(...found.files);
      ignored.push(...found.ignored);
    }
    // A file named by several hooks (a "*" and a "startup" group, or one command twice) is added
    // once, as Claude Code runs identical hook commands once.
    const seen = new Set();
    const unique = files.filter((file) => !seen.has(file.path) && seen.add(file.path));
    for (const file of unique) file.text = (await readFile(file.path, 'utf8').catch(() => '')).slice(0, FILE_MAX).trim();
    const report = { files: unique.filter((f) => f.text), ignored };
    cache = { at: Date.now(), report };
    return report;
  }
  return {
    scan,
    forget: () => { cache = undefined; },
    async section() {
      const { files } = await scan();
      if (!files.length) return undefined;
      const parts = [];
      let used = 0;
      let left = 0;
      for (const file of files) {
        const part = `### From ${file.source === 'mars' ? 'Mars hooks' : file.source.slice(7) + ' (plugin)'}\n\n${file.text}`;
        if (used + part.length > SECTION_MAX) { left++; continue; }
        parts.push(part);
        used += part.length;
      }
      return [
        '## Session start notes',
        '',
        'These notes come from the owner\'s session start hooks. Follow them as standing instructions. Where they name Claude Code tools: "the Skill tool" or a skill such as `pstack:tdd` means skill_read with the name after the colon ("tdd"); "the Task tool" or "spawn the X subagent" means agent_run with agent "X".',
        '',
        ...parts,
        ...(left ? [`(${left} more session start files left out: over 16000 characters.)`] : []),
      ].join('\n');
    },
  };
}

/** The section only. Workers (agent_run and worker_run jobs) skip it, as Claude Code subagents do. */
export function createSessionHooksExtension({ hooks }) {
  return defineExtension({
    name: 'mars-hooks',
    sections: [section('session-start', async (input, context) => {
      if (input?.agent?.instructions) return undefined;
      const label = await input?.read?.snapshot?.(nativeTitleDoc, input.conversationId, context).catch(() => undefined);
      if (label?.task) return undefined;
      return hooks.section();
    }, { tag: false })],
  });
}

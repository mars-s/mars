// Skills (docs/SKILLS.md): folders of Markdown instructions with a SKILL.md, the format used by
// Claude Code, Codex and the `npx skills` installer. Mars reads them from its own folder and
// the shared user folders, lists them to the model in one short section, and loads a skill's
// full text only when the model asks for it. The files on disk are the only store.
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';

const run = promisify(execFile);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SKILL_TEXT_MAX = 60000;
const FILE_TEXT_MAX = 60000;
// About 4,000 tokens: room for roughly 150 skills at one short line each.
const CATALOGUE_MAX = 16000;
const LINE_DESCRIPTION_MAX = 80;

/** The folders searched, first wins on a name clash: Mars's own, then the shared user folders. */
export function skillRoots({ work, env = process.env, home = env.HOME || homedir() }) {
  const extra = (env.MARS_SKILL_DIRS || '').split(':').filter(Boolean);
  return [
    { dir: join(work, 'skills'), source: 'mars', writable: true },
    ...extra.map((dir) => ({ dir, source: 'custom', writable: false })),
    { dir: join(home, '.agents', 'skills'), source: 'agents', writable: false },
    { dir: join(home, '.claude', 'skills'), source: 'claude', writable: false },
  ];
}

/** Front matter of a SKILL.md: simple `key: value` lines, quoted values and `>`/`|` blocks. */
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!pair) continue;
      let value = pair[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
        value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
      } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      meta[pair[1]] = value;
    }
  }
  return { meta, body: match ? text.slice(match[0].length) : text };
}

const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : flat;
};

export function createSkills({ roots, cacheMs = 15000 }) {
  let cache;
  async function scan() {
    if (cache && Date.now() - cache.at < cacheMs) return cache.skills;
    const byName = new Map();
    for (const { dir, source, writable } of roots) {
      let names = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const folder of names.sort()) {
        if (folder.startsWith('.')) continue;
        const path = join(dir, folder);
        let text;
        try {
          if (!(await stat(path)).isDirectory()) continue;
          text = await readFile(join(path, 'SKILL.md'), 'utf8');
        } catch { continue; }
        const { meta } = parseSkill(text.slice(0, 8000));
        const name = String(meta.name || folder).trim().toLowerCase();
        if (!NAME.test(name) || byName.has(name)) continue;
        byName.set(name, { name, description: oneLine(meta.description, 1000), source, writable, path });
      }
    }
    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: Date.now(), skills };
    return skills;
  }
  const forget = () => { cache = undefined; };
  async function find(name) {
    const skill = (await scan()).find((row) => row.name === String(name || '').trim().toLowerCase().replace(/^\//, ''));
    if (!skill) throw fail(`No skill named "${name}". Call skill_list to see the names.`, 404);
    return skill;
  }
  async function files(dir, prefix = '', out = [], depth = 0) {
    if (depth > 4 || out.length >= 200) return out;
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await files(join(dir, entry.name), rel, out, depth + 1);
      else if (rel !== 'SKILL.md') out.push(rel);
      if (out.length >= 200) break;
    }
    return out;
  }
  return {
    scan,
    forget,
    /** The short list the model sees on every turn, bounded so a large collection stays cheap. */
    async catalogue() {
      const skills = await scan();
      if (!skills.length) return undefined;
      const lines = [];
      let used = 0;
      for (const skill of skills) {
        const line = `- ${skill.name}: ${oneLine(skill.description, LINE_DESCRIPTION_MAX)}`;
        if (used + line.length > CATALOGUE_MAX) break;
        lines.push(line);
        used += line.length + 1;
      }
      const more = skills.length - lines.length;
      return [
        '## Skills',
        '',
        'Skills are the owner\'s saved instructions for particular kinds of work. When a request matches one, call skill_read with its name first and follow it. When the owner writes /name (for example /grill-me), use that skill. Make or change your own with skill_create, and add published ones with skill_install.',
        '',
        ...lines,
        ...(more > 0 ? [`(${more} more: call skill_list with a query to find them.)`] : []),
      ].join('\n');
    },
    async list(query = '') {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const skills = await scan();
      const matched = words.length
        ? skills.filter((skill) => words.every((word) => (skill.name + ' ' + skill.description).toLowerCase().includes(word)))
        : skills;
      return { total: skills.length, skills: matched.slice(0, 100).map(({ name, description, source }) => ({ name, description: oneLine(description, 300), source })) };
    },
    async read(name, file) {
      const skill = await find(name);
      const base = await realpath(skill.path);
      if (file) {
        const target = resolve(base, String(file));
        const real = await realpath(target).catch(() => { throw fail(`No file "${file}" in skill ${skill.name}`, 404); });
        if (real !== base && !real.startsWith(base + sep)) throw fail('file must be inside the skill folder');
        const info = await stat(real);
        if (!info.isFile()) throw fail(`"${file}" is not a file`);
        const text = (await readFile(real, 'utf8')).slice(0, FILE_TEXT_MAX);
        return { name: skill.name, file: relative(base, real), text, truncated: info.size > FILE_TEXT_MAX };
      }
      const raw = await readFile(join(base, 'SKILL.md'), 'utf8');
      return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        text: raw.slice(0, SKILL_TEXT_MAX),
        truncated: raw.length > SKILL_TEXT_MAX,
        files: await files(base),
      };
    },
    /** Write or replace one of Mars's own skills. Shared user folders are never written. */
    async create({ name, description, instructions }) {
      const own = roots.find((root) => root.writable);
      if (!NAME.test(String(name || ''))) throw fail('name must be lowercase letters, digits, dots, dashes or underscores, up to 64');
      if (!String(description || '').trim()) throw fail('description must say when to use the skill');
      if (!String(instructions || '').trim()) throw fail('instructions must not be empty');
      const existing = (await scan()).find((row) => row.name === name);
      if (existing && !existing.writable) throw fail(`"${name}" belongs to ${existing.source} skills at ${existing.path}; choose another name`);
      const dir = join(own.dir, name);
      await mkdir(dir, { recursive: true });
      const front = `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine(description, 1000))}\n---\n\n`;
      await writeFile(join(dir, 'SKILL.md'), front + String(instructions).trim() + '\n');
      forget();
      return { name, path: dir, replaced: !!existing };
    },
    /**
     * Copy every skill folder found in a GitHub repository (owner/repo, owner/repo/sub/path or
     * a GitHub or git URL), or a local folder, into Mars's own skills folder.
     */
    async install({ source, ref }) {
      const own = roots.find((root) => root.writable);
      const spec = String(source || '').trim();
      if (!spec) throw fail('source is required');
      if (ref !== undefined && !/^[\w./-]{1,100}$/.test(ref)) throw fail('ref must be a branch, tag or commit');
      const work = await mkdtemp(join(tmpdir(), 'mars-skill-'));
      try {
        let from;
        let sub = '';
        if (spec.startsWith('/') || spec.startsWith('~/')) from = resolve(spec.replace(/^~(?=\/)/, homedir()));
        else {
          let url = spec;
          const short = /^([\w.-]+)\/([\w.-]+)((?:\/[\w.@-]+)*)$/.exec(spec);
          const github = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)((?:\/[^/]+)*))?\/?$/.exec(spec);
          if (short) { url = `https://github.com/${short[1]}/${short[2]}.git`; sub = short[3].slice(1); }
          else if (github) { url = `https://github.com/${github[1]}/${github[2]}.git`; ref ??= github[3]; sub = (github[4] || '').slice(1); }
          else if (!/^(https:\/\/|git@|file:\/\/)[\w.@:/~-]+$/.test(spec)) throw fail('source must be owner/repo, a GitHub or git URL, or a local folder');
          await run('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, join(work, 'repo')], { timeout: 120000 });
          from = join(work, 'repo');
        }
        const start = resolve(from, sub);
        if (start !== from && !start.startsWith(from + sep)) throw fail('path must stay inside the repository');
        const found = [];
        const walk = async (dir, depth) => {
          if (depth > 6 || found.length >= 300) return;
          let entries;
          try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
          if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) { found.push(dir); return; }
          for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(join(dir, entry.name), depth + 1);
        };
        await walk(start, 0);
        if (!found.length) throw fail('No SKILL.md found in that source', 404);
        await mkdir(own.dir, { recursive: true });
        const installed = [];
        const skipped = [];
        for (const dir of found) {
          const { meta } = parseSkill(await readFile(join(dir, 'SKILL.md'), 'utf8'));
          const name = String(meta.name || basename(dir)).trim().toLowerCase();
          if (!NAME.test(name)) { skipped.push({ path: relative(from, dir), reason: 'name is not a valid skill name' }); continue; }
          const target = join(own.dir, name);
          const staged = join(work, 'staged-' + name);
          await cp(dir, staged, { recursive: true, dereference: false, filter: (path) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(relative(dir, path)) });
          await rm(target + '.previous', { recursive: true, force: true });
          const had = await lstat(target).then(() => true, () => false);
          if (had) await rename(target, target + '.previous');
          await rename(staged, target).catch(async () => { await cp(staged, target, { recursive: true }); });
          if (had) await rm(target + '.previous', { recursive: true, force: true });
          installed.push({ name, description: oneLine(meta.description, 300), replaced: had });
        }
        forget();
        return { installed, skipped, folder: own.dir };
      } catch (error) {
        if (error.code === 'ENOENT' && /git/.test(String(error.path))) throw fail('git is not installed on this machine');
        if (error.stderr) throw fail('Could not fetch the source: ' + String(error.stderr).trim().split('\n').at(-1));
        throw error;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

const result = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const SkillRow = Type.Object({
  name: Type.String({ description: 'Skill name, for skill_read.' }),
  description: Type.String({ description: 'When to use it, from the skill itself.' }),
  source: Type.String({ description: '"mars" (Mars\'s own folder), "agents" (~/.agents/skills), "claude" (~/.claude/skills) or "custom".' }),
});

export function createSkillsExtension({ skills }) {
  return defineExtension({
    name: 'mars-skills',
    sections: [section('skills', () => skills.catalogue(), { tag: false })],
    tools: [
      defineTool({
        name: 'skill_list',
        description: `List the owner's skills, or find skills by words in their name or description.
Use it when no skill in the prompt's Skills list fits, or to search a long collection. It returns names and when to use each; then call skill_read to load one. Up to 100 results.
Example: await tools.skill_list({ query: "animation" })`,
        parameters: Type.Object({
          query: Type.Optional(Type.String({ maxLength: 200, description: 'Words that must all appear in the name or description, e.g. "review code". Omit to list all.' })),
        }),
        structuredOutputSchema: Type.Object({
          total: Type.Integer({ description: 'How many skills are installed in all.' }),
          skills: Type.Array(SkillRow, { description: 'Matching skills, by name.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => result(await skills.list(args.query)),
      }),
      defineTool({
        name: 'skill_read',
        description: `Load a skill's full instructions, or one of the files that come with it.
Use it before doing work a skill covers, then follow what it says. Without file it returns SKILL.md and the list of extra files in the skill folder (references, scripts, templates); pass one of those paths as file to read it. Paths are relative to the skill folder.
Example: await tools.skill_read({ name: "grill-me" })`,
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 64, description: 'Skill name from the Skills list or skill_list, e.g. "tdd". A leading "/" is ignored.' }),
          file: Type.Optional(Type.String({ maxLength: 500, description: 'A file inside the skill folder from the files list, e.g. "references/patterns.md". Omit for SKILL.md.' })),
        }),
        structuredOutputSchema: Type.Object({
          name: Type.String({ description: 'Skill name.' }),
          text: Type.String({ description: 'The file text (SKILL.md unless file was given), up to 60000 characters.' }),
          truncated: Type.Boolean({ description: 'True when the text was cut at 60000 characters.' }),
          description: Type.Optional(Type.String({ description: 'When to use the skill (SKILL.md only).' })),
          source: Type.Optional(Type.String({ description: 'Which skills folder it came from (SKILL.md only).' })),
          files: Type.Optional(Type.Array(Type.String(), { description: 'Other files in the skill folder, relative paths (SKILL.md only).' })),
          file: Type.Optional(Type.String({ description: 'The file read, relative to the skill folder.' })),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => result(await skills.read(args.name, args.file)),
      }),
      defineTool({
        name: 'skill_create',
        description: `Save a new skill, or replace one of Mars's own, as Markdown instructions you can reuse.
Use it when the owner asks you to remember how to do something, or to change a skill you made. It writes SKILL.md in Mars's own skills folder; skills in the shared folders (~/.agents/skills, ~/.claude/skills) are never changed. The skill appears in the Skills list on the next turn.
Example: await tools.skill_create({ name: "release-notes", description: "Use when writing release notes for Mars.", instructions: "1. Read the changelog since the last tag.\\n2. Group by user-facing change." })`,
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 64, description: 'Lowercase name with dashes, e.g. "release-notes". Also the folder name.' }),
          description: Type.String({ minLength: 1, maxLength: 1000, description: 'One or two sentences on when to use it, starting "Use when ...".' }),
          instructions: Type.String({ minLength: 1, maxLength: 60000, description: 'The skill body in Markdown: steps, rules and examples to follow.' }),
        }),
        structuredOutputSchema: Type.Object({
          name: Type.String({ description: 'Skill name.' }),
          path: Type.String({ description: 'Folder the skill was written to.' }),
          replaced: Type.Boolean({ description: 'True when an existing skill of Mars\'s own was replaced.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => result(await skills.create(args)),
      }),
      defineTool({
        name: 'skill_install',
        description: `Install published skills from GitHub, a git URL or a local folder into Mars's own skills folder.
Use it when the owner names a skills repository, e.g. "mattpocock/skills" or "npx skills add emilkowalski/skill" (pass "emilkowalski/skill"). Every folder with a SKILL.md in the source is copied; a skill with the same name is replaced. It returns what was installed. For a website that only offers a download, fetch it with host_exec and pass the unpacked folder path.
Example: await tools.skill_install({ source: "mattpocock/skills" })`,
        parameters: Type.Object({
          source: Type.String({ minLength: 3, maxLength: 500, description: 'owner/repo, owner/repo/sub/folder, a https://github.com/... or git URL, or an absolute local folder path.' }),
          ref: Type.Optional(Type.String({ maxLength: 100, description: 'Branch, tag or commit to install. Default: the repository default branch.' })),
        }),
        structuredOutputSchema: Type.Object({
          installed: Type.Array(Type.Object({
            name: Type.String({ description: 'Skill name.' }),
            description: Type.String({ description: 'When to use it.' }),
            replaced: Type.Boolean({ description: 'True when it replaced a skill of the same name.' }),
          }), { description: 'Skills now installed.' }),
          skipped: Type.Array(Type.Object({
            path: Type.String({ description: 'Folder in the source.' }),
            reason: Type.String({ description: 'Why it was not installed.' }),
          }), { description: 'Folders that were not installed.' }),
          folder: Type.String({ description: 'Mars\'s own skills folder.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => result(await skills.install(args)),
      }),
    ],
  });
}

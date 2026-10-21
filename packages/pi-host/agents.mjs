// Named agents (docs/AGENTS-AND-HOOKS.md): Markdown files with front matter `name` and
// `description`, the Claude Code subagent format. Mars reads them from its own folder, the
// shared user folders and installed Claude Code plugins, lists them in one short section, and
// runs one as a worker whose instructions are the file's body. The files are the only store.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { NAME, parseSkill } from './skills.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const AGENT_TEXT_MAX = 60000;
const CATALOGUE_MAX = 6000;
const LINE_DESCRIPTION_MAX = 100;
const ALIASES = ['luna', 'sol', 'astra', 'opus'];
const FAMILY_FALLBACK = { haiku: 'luna', sonnet: 'sol' };

export const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : flat;
};
const unquote = (value) => String(value || '').replace(/\\(["\\])/g, '$1');

/**
 * Claude Code plugin folders, in search order: ~/.codex/<any>/plugins/<plugin>, then a bounded
 * walk of ~/.claude/plugins for folders with .claude-plugin/plugin.json, agents/ or hooks/hooks.json.
 * The same plugin name found twice keeps the first.
 */
export async function findPlugins({ home = process.env.HOME || homedir(), maxDirs = 3000, maxDepth = 6 } = {}) {
  const found = [];
  const names = new Set();
  const list = async (dir) => { try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name); } catch { return []; } };
  const exists = (path) => stat(path).then(() => true, () => false);
  async function add(root, fallback) {
    let name = fallback;
    try { name = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name || fallback; } catch { /* folder name */ }
    name = String(name);
    if (names.has(name)) return;
    names.add(name);
    found.push({ root, name });
  }
  const codex = join(home, '.codex');
  for (const top of (await list(codex)).sort())
    for (const plugin of (await list(join(codex, top, 'plugins'))).sort()) await add(join(codex, top, 'plugins', plugin), plugin);
  let visited = 0;
  const base = join(home, '.claude', 'plugins');
  async function walk(dir, depth) {
    if (depth > maxDepth || visited++ >= maxDirs) return;
    if (depth > 0 && (await exists(join(dir, '.claude-plugin', 'plugin.json')) || await exists(join(dir, 'agents')) || await exists(join(dir, 'hooks', 'hooks.json')))) {
      await add(dir, dir.split('/').filter((part) => !/^v?\d+(\.\d+)*$/.test(part)).at(-1));
      return;
    }
    let entries = await list(dir);
    // Version folders (cache/<market>/<plugin>/<version>): newest first.
    if (entries.length && entries.every((n) => /^v?\d/.test(n))) entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    else entries.sort();
    for (const entry of entries) await walk(join(dir, entry), depth + 1);
  }
  await walk(base, 0);
  return found;
}

/** Agent folders, first wins on a name clash. Plugin folders are found when scanned. */
export function agentRoots({ work, env = process.env, home = env.HOME || homedir() }) {
  const extra = (env.MARS_AGENT_DIRS || '').split(':').filter(Boolean);
  return [
    { dir: join(work, 'agents'), source: 'mars', writable: true },
    ...extra.map((dir) => ({ dir, source: 'custom', writable: false })),
    { dir: join(home, '.agents', 'agents'), source: 'agents', writable: false },
    { dir: join(home, '.claude', 'agents'), source: 'claude', writable: false },
    { plugins: true, home },
  ];
}

/**
 * Map a Claude Code or Mars model name to a worker selection: an alias (luna, sol, astra, opus),
 * an exact model id, a Claude family (opus, sonnet, haiku, claude-sonnet-4-5) or "inherit".
 */
export function resolveAgentModel(models, wanted, inherited) {
  const name = String(wanted || 'inherit').trim();
  const lower = name.toLowerCase();
  const inherit = () => inherited?.provider && inherited?.modelId && models.getModel(inherited.provider, inherited.modelId) ? { provider: inherited.provider, modelId: inherited.modelId } : { model: 'sol' };
  if (lower === 'inherit') return inherit();
  if (ALIASES.includes(lower)) return { model: lower };
  const exact = models.getModels().filter((m) => m.id === name).sort((a, b) => Number(b.provider === 'anthropic' || b.provider === 'openai') - Number(a.provider === 'anthropic' || a.provider === 'openai'))[0];
  if (exact) return { provider: exact.provider, modelId: exact.id };
  const family = /(opus|sonnet|haiku)/.exec(lower)?.[1];
  if (family === 'opus') return { model: 'opus' };
  if (family) {
    const pattern = new RegExp('^claude-' + family + '-\\d+(-\\d+)?$');
    const best = models.getModels().filter((m) => m.provider === 'anthropic' && pattern.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
    return best ? { provider: 'anthropic', modelId: best.id } : { model: FAMILY_FALLBACK[family] };
  }
  return inherit();
}

/** What a worker started by agent_run is told before the agent's own body. */
export function agentInstructions(agent, body) {
  return [
    `# Agent: ${agent.name}`,
    '',
    `You are running as the named agent "${agent.name}", started by another Mars conversation through agent_run. You do not see that conversation: the user message is your whole brief. Your final message is returned as your answer, so end with the result it asked for.`,
    '',
    'These instructions may be written for Claude Code. Where they name its tools, use the Mars ones: Read, Write, Edit are read, write, edit; Bash, Grep, Glob are bash (or host_exec); WebFetch and WebSearch are web_fetch and web_search; the Skill tool is skill_read; the Task tool or another subagent is agent_run.',
    '',
    String(body).trim().slice(0, AGENT_TEXT_MAX),
  ].join('\n');
}

export function createAgents({ roots, cacheMs = 15000, plugins = findPlugins }) {
  let cache;
  async function readDir(dir, source, writable, byName) {
    let names = [];
    try { names = await readdir(dir); } catch { return; }
    for (const file of names.sort()) {
      if (file.startsWith('.') || !file.endsWith('.md')) continue;
      const path = join(dir, file);
      let text;
      try {
        if (!(await stat(path)).isFile()) continue;
        text = await readFile(path, 'utf8');
      } catch { continue; }
      const { meta } = parseSkill(text.slice(0, 8000));
      const name = String(meta.name || '').trim().toLowerCase();
      const description = oneLine(unquote(meta.description), 1000);
      if (!NAME.test(name) || !description || byName.has(name)) continue;
      byName.set(name, { name, description, source, writable, path, ...(meta.model ? { model: String(meta.model).trim() } : {}) });
    }
  }
  async function scan() {
    if (cache && Date.now() - cache.at < cacheMs) return cache.agents;
    const byName = new Map();
    for (const root of roots) {
      if (root.plugins) {
        for (const plugin of await plugins({ home: root.home })) await readDir(join(plugin.root, 'agents'), 'plugin:' + plugin.name, false, byName);
      } else await readDir(root.dir, root.source, root.writable, byName);
    }
    const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: Date.now(), agents };
    return agents;
  }
  const forget = () => { cache = undefined; };
  async function find(name) {
    // "pstack:comment-sicko" (Claude Code's plugin form) and "@comment-sicko" mean "comment-sicko".
    const wanted = String(name || '').trim().toLowerCase().replace(/^[@/]/, '').replace(/^[\w.-]+:/, '');
    const agent = (await scan()).find((row) => row.name === wanted);
    if (!agent) throw fail(`No agent named "${name}". Call agent_list to see the names.`, 404);
    return agent;
  }
  return {
    scan,
    forget,
    find,
    async catalogue() {
      const agents = await scan();
      if (!agents.length) return undefined;
      const lines = [];
      let used = 0;
      for (const agent of agents) {
        const line = `- ${agent.name}: ${oneLine(agent.description, LINE_DESCRIPTION_MAX)}`;
        if (used + line.length > CATALOGUE_MAX) break;
        lines.push(line);
        used += line.length + 1;
      }
      const more = agents.length - lines.length;
      return [
        '## Agents',
        '',
        'Named agents are helper models with their own standing instructions (Claude Code subagents). When a skill or the owner says to spawn, launch or use a named subagent, for example "spawn the comment-sicko subagent", call agent_run with that agent and a complete brief: it does not see this chat. "pstack:comment-sicko" means "comment-sicko". Make your own with agent_create.',
        '',
        ...lines,
        ...(more > 0 ? [`(${more} more: call agent_list with a query to find them.)`] : []),
      ].join('\n');
    },
    async list(query = '') {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const agents = await scan();
      const matched = words.length ? agents.filter((a) => words.every((w) => (a.name + ' ' + a.description).toLowerCase().includes(w))) : agents;
      return { total: agents.length, agents: matched.slice(0, 100).map(({ name, description, source, model }) => ({ name, description: oneLine(description, 300), source, ...(model ? { model } : {}) })) };
    },
    async body(name) {
      const agent = await find(name);
      return { agent, body: parseSkill(await readFile(agent.path, 'utf8')).body };
    },
    /** Write or replace one of Mars's own agents. Shared and plugin folders are never written. */
    async create({ name, description, instructions, model }) {
      const own = roots.find((root) => root.writable);
      if (!NAME.test(String(name || ''))) throw fail('name must be lowercase letters, digits, dots, dashes or underscores, up to 64');
      if (!String(description || '').trim()) throw fail('description must say when to use the agent');
      if (!String(instructions || '').trim()) throw fail('instructions must not be empty');
      if (model !== undefined && !/^[\w.:-]{1,80}$/.test(model)) throw fail('model must be a name such as "sol", "opus" or "inherit"');
      const existing = (await scan()).find((row) => row.name === name);
      if (existing && !existing.writable) throw fail(`"${name}" belongs to ${existing.source} agents at ${existing.path}; choose another name`);
      await mkdir(own.dir, { recursive: true });
      const path = join(own.dir, name + '.md');
      const front = `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine(description, 1000))}\n${model ? `model: ${model}\n` : ''}---\n\n`;
      await writeFile(path, front + String(instructions).trim() + '\n');
      forget();
      return { name, path, replaced: !!existing };
    },
  };
}

const result = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const MODEL_CHOICES = ['luna', 'sol', 'astra', 'opus', 'sonnet', 'haiku', 'inherit'];

/** agent_list, agent_run and agent_create, and the Agents prompt section. */
export function createAgentsExtension({ agents, models, runWorkers, hooks }) {
  return defineExtension({
    name: 'mars-agents',
    sections: [section('agents', () => agents.catalogue(), { tag: false })],
    tools: [
      defineTool({
        name: 'agent_list',
        description: `List the owner's named agents, or find agents by words in their name or description.
Use it when no agent in the prompt's Agents list fits, or to check which session start notes are in use. It returns each agent's name, when to use it and its model, plus the session start files read and any hooks ignored with why. Then call agent_run with a name. Up to 100 agents.
Example: await tools.agent_list({ query: "review" })`,
        parameters: Type.Object({
          query: Type.Optional(Type.String({ maxLength: 200, description: 'Words that must all appear in the name or description, e.g. "comment". Omit to list all.' })),
        }),
        structuredOutputSchema: Type.Object({
          total: Type.Integer({ description: 'How many agents are installed in all.' }),
          agents: Type.Array(Type.Object({
            name: Type.String({ description: 'Agent name, for agent_run.' }),
            description: Type.String({ description: 'When to use it, from the agent file.' }),
            source: Type.String({ description: '"mars", "custom", "agents", "claude" or "plugin:<name>".' }),
            model: Type.Optional(Type.String({ description: 'Model named in the agent file, e.g. "opus" or "inherit".' })),
          }), { description: 'Matching agents, by name.' }),
          sessionStart: Type.Object({
            files: Type.Array(Type.Object({
              source: Type.String({ description: '"mars" or "plugin:<name>".' }),
              path: Type.String({ description: 'Markdown file added at the start of each conversation.' }),
            }), { description: 'Session start files in use.' }),
            ignored: Type.Array(Type.Object({
              source: Type.String({ description: 'Where the hook came from.' }),
              reason: Type.String({ description: 'Why Mars did not use it.' }),
            }), { description: 'Hooks Mars skipped.' }),
          }, { description: 'Session start notes, from hooks.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => {
          const listed = await agents.list(args.query);
          const report = hooks ? await hooks.scan() : { files: [], ignored: [] };
          return result({ ...listed, sessionStart: { files: report.files.map(({ source, path }) => ({ source, path })), ignored: report.ignored.map(({ source, reason }) => ({ source, reason })) } });
        },
      }),
      defineTool({
        name: 'agent_run',
        description: `Run a task with one of the owner's named agents and wait for its answer.
Use it when a skill or the owner says to spawn or use a named subagent, e.g. "spawn the comment-sicko subagent". The agent is a helper model whose instructions are its Markdown file; it sees only task, not this chat, so write task as a complete brief (files, diff, what to return). It returns the agent's final answer in result and the worker id for worker_followup. For a helper with no named agent, use worker_run.
Example: const { result } = await tools.agent_run({ agent: "comment-sicko", task: "Review the comments in the diff of packages/pi-host against main and list what to delete." })`,
        parameters: Type.Object({
          agent: Type.String({ minLength: 1, maxLength: 120, description: 'Agent name from the Agents list or agent_list, e.g. "comment-sicko". "pstack:comment-sicko" also works.' }),
          task: Type.String({ minLength: 1, description: 'Everything the agent needs, as a complete brief: it does not see this conversation.' }),
          model: Type.Optional(Type.Union(MODEL_CHOICES.map((m) => Type.Literal(m)), { description: 'Override the agent file\'s model. luna fast, sol all-rounder, astra hardest reasoning, opus Claude; sonnet and haiku pick that Claude family; inherit uses this chat\'s model (the default when the file names none).' })),
          title: Type.Optional(Type.String({ maxLength: 160, description: 'Short name shown in the sidebar, e.g. "Comment review".' })),
        }),
        structuredOutputSchema: Type.Object({
          agent: Type.String({ description: 'The agent that ran.' }),
          id: Type.String({ description: 'Worker id. Pass it to worker_followup to ask more.' }),
          status: Type.String({ description: '"completed", "aborted" or "unanswered".' }),
          result: Type.String({ description: "The agent's final answer, up to 4000 characters." }),
          provider: Type.String({ description: 'Provider used.' }),
          modelId: Type.String({ description: 'Model used.' }),
        }),
        deferred: true,
        replay: 'safe',
        executionMode: 'parallel',
        execute: async (args, api, ctx) => {
          const { agent, body } = await agents.body(args.agent);
          const inherited = (await api.agent(ctx))?.model;
          const selection = resolveAgentModel(models, args.model || agent.model, inherited);
          const outcome = await runWorkers([{ task: args.task, title: (args.title?.trim() || `${agent.name}: ${args.task.trim()}`).slice(0, 160), ...selection, instructions: agentInstructions(agent, body) }], api, ctx);
          const row = outcome?.result?.[0] || {};
          return result({ agent: agent.name, id: String(row.id ?? ''), status: row.status || outcome?.status || 'aborted', result: row.result || '', provider: row.provider || '', modelId: row.modelId || '' });
        },
      }),
      defineTool({
        name: 'agent_create',
        description: `Save a new named agent, or replace one of Mars's own, as Markdown instructions a helper model follows.
Use it when the owner asks for a reusable helper with a fixed role, e.g. a strict reviewer. It writes <name>.md in Mars's own agents folder; agents in shared or plugin folders are never changed. The agent appears in the Agents list on the next turn; run it with agent_run. For saved how-to steps you follow yourself, use skill_create instead.
Example: await tools.agent_create({ name: "test-critic", description: "Use to review new tests for missing cases.", instructions: "You review tests. List missing edge cases, one per line." })`,
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 64, description: 'Lowercase name with dashes, e.g. "test-critic". Also the file name.' }),
          description: Type.String({ minLength: 1, maxLength: 1000, description: 'One or two sentences on when to use the agent, starting "Use to ...".' }),
          instructions: Type.String({ minLength: 1, maxLength: 60000, description: 'The agent body in Markdown: its role, rules and what to return.' }),
          model: Type.Optional(Type.Union(MODEL_CHOICES.map((m) => Type.Literal(m)), { description: 'Model the agent uses by default, e.g. "sol". Omit to use the calling chat\'s model.' })),
        }),
        structuredOutputSchema: Type.Object({
          name: Type.String({ description: 'Agent name.' }),
          path: Type.String({ description: 'File the agent was written to.' }),
          replaced: Type.Boolean({ description: 'True when an existing agent of Mars\'s own was replaced.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => result(await agents.create(args)),
      }),
    ],
  });
}

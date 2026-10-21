// Scores one harness config on one task set with a local model (docs/HARNESS-LOOP.md).
// Every request is sent `runs` times with all Mars tools offered, the config's overrides
// applied and its guide as the system message. A run counts as right (expected tool),
// valid (arguments pass the tool's schema) and fully correct (the arguments also mean
// what was asked). The result names the config, tool dump and model it came from.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import { UPSTREAM_TOOLS } from '../tool-quality.mjs';
import { applyOverrides, hashOf, systemMessage } from './config.mjs';

export const MODEL = process.env.EVAL_MODEL || 'qwen2.5:1.5b';
export const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/** The installed Mars tools (upstream tools left out, as in eval-tools-small-model.mjs) and a hash of them. */
export function dumpTools() {
  const base = mkdtempSync(join(tmpdir(), 'mars harness '));
  const out = join(base, 'tools.json');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    cwd: base,
    env: { ...process.env, MARS_PI_ROOT: join(base, 'data'), MARS_PI_PORT: '39183', MARS_UI_PORT: '39184', MARS_PI_STAGING: '1', MARS_DUMP_TOOLS: out },
  });
  if (run.status !== 0) throw Error('Could not dump the host tools: ' + run.stderr);
  const rows = JSON.parse(readFileSync(out, 'utf8'))
    .filter((row) => !UPSTREAM_TOOLS.has(row.name))
    .map(({ name, description, parameters, output }) => ({ name, description, parameters, output }));
  return { rows, toolsHash: hashOf(rows) };
}

/**
 * One chat call to Ollama. Returns the first tool call, or nulls when the model answered
 * in text. Replies are capped at 400 tokens: a 1.5B model sometimes repeats itself until
 * the context fills, and a tool call never needs that many. A capped reply is a no-call.
 */
export async function ollamaChat({ system, user, tools, model = MODEL }) {
  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model, stream: false, tools, options: { temperature: 0.7, seed: Math.floor(Math.random() * 1e9), num_predict: 400 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!response.ok) throw Error(`Ollama answered ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const call = data.message?.tool_calls?.[0]?.function;
  if (!call) return { name: null, args: null };
  let args = call.arguments;
  if (typeof args === 'string') try { args = JSON.parse(args); } catch { args = null; }
  return { name: call.name, args };
}

const toTool = (row) => ({ type: 'function', function: { name: row.name, description: row.description, parameters: row.parameters ?? { type: 'object', properties: {} } } });

/**
 * @returns {{ configId, set, model, toolsHash, runs, right, valid, fullyCorrect, total,
 *   misses: { task: number, run: number, expected: string, picked: string|null, args: unknown, kind: 'no-call'|'wrong-tool'|'bad-args' }[] }}
 */
export async function scoreConfig({ config, set, tasks, rows, toolsHash, runs = 3, model = MODEL, chat = ollamaChat }) {
  const offered = applyOverrides(rows, config);
  const tools = offered.map(toTool);
  const checks = Object.fromEntries(offered.map((row) => [row.name, row.parameters ? Compile(row.parameters) : null]));
  const system = systemMessage(config);
  const result = { configId: config.id, set, model, toolsHash, runs, right: 0, valid: 0, fullyCorrect: 0, total: 0, misses: [] };
  for (const [index, task] of tasks.entries()) {
    for (let run = 0; run < runs; run++) {
      const { name, args } = await chat({ system, user: task.request, tools, model });
      result.total++;
      const miss = { task: index, run, expected: task.tool, picked: name, args };
      if (name !== task.tool) {
        result.misses.push({ ...miss, kind: name ? 'wrong-tool' : 'no-call' });
        continue;
      }
      result.right++;
      const valid = args != null && typeof args === 'object' && (!checks[name] || checks[name].Check(args));
      if (valid) result.valid++;
      let meant = false;
      if (valid) try { meant = task.wants(args) === true; } catch {}
      if (meant) result.fullyCorrect++;
      else result.misses.push({ ...miss, kind: 'bad-args' });
    }
  }
  return result;
}

/** The counts only. This is all that leaves the runner for a held-out set. */
export const counts = ({ configId, set, model, toolsHash, runs, right, valid, fullyCorrect, total }) => ({ configId, set, model, toolsHash, runs, right, valid, fullyCorrect, total });

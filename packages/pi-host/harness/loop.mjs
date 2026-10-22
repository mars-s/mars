// Runs improvement rounds against the local model and logs them (docs/HARNESS-LOOP.md).
//
//   ollama serve & ollama pull qwen2.5:1.5b
//   node harness/loop.mjs [--rounds 2] [--runs 3] [--margin 2] [--from <config id>] [--rule-only]
//
// Starts from the config built from HOST-GUIDE.md unless --from names a saved config.
// Writes every config it scores to harness/configs/ and one TSV row per score and per
// decision to .agents/goals/harness-rounds.tsv. It never edits HOST-GUIDE.md or a tool.
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, makeConfig, saveConfig } from './config.mjs';
import { DEFAULT_MARGIN } from './promotion.mjs';
import { propose } from './proposer.mjs';
import { runRound } from './round.mjs';
import { MODEL, OLLAMA, dumpTools, scoreConfig } from './runner.mjs';
import { DEV_TASKS } from './tasks-dev.mjs';
import { HELDOUT_TASKS } from './tasks-heldout.mjs';

const { values } = parseArgs({ options: {
  rounds: { type: 'string', default: '2' }, runs: { type: 'string', default: '3' }, margin: { type: 'string', default: String(DEFAULT_MARGIN) },
  from: { type: 'string' }, 'rule-only': { type: 'boolean', default: false },
  log: { type: 'string', default: fileURLToPath(new URL('../../../.agents/goals/harness-rounds.tsv', import.meta.url)) },
} });
const rounds = Number(values.rounds), runs = Number(values.runs), margin = Number(values.margin);

const COLUMNS = ['time', 'round', 'kind', 'role', 'set', 'config_id', 'parent_id', 'model', 'tools_hash', 'runs', 'right', 'valid', 'fully_correct', 'total', 'decision', 'detail'];
const clean = (value) => String(value ?? '').replace(/[\t\n]+/g, ' ');
if (!existsSync(values.log)) writeFileSync(values.log, COLUMNS.join('\t') + '\n');
const firstRound = 1 + Math.max(0, ...readFileSync(values.log, 'utf8').trim().split('\n').slice(1).map((line) => Number(line.split('\t')[1]) || 0));

const missSummary = (result) => {
  const counts = {};
  for (const miss of result.misses ?? []) counts[`${miss.expected}:${miss.kind}`] = (counts[`${miss.expected}:${miss.kind}`] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}x${count}`).join(' ');
};

async function log(entry) {
  const time = new Date().toISOString();
  let row;
  if (entry.kind === 'score') {
    const r = entry.result;
    row = [time, entry.round, 'score', entry.role, r.set, r.configId, entry.parentId ?? '', r.model, r.toolsHash, r.runs, r.right, r.valid, r.fullyCorrect, r.total, '', r.set === 'dev' ? missSummary(r) : 'counts only'];
    console.log(`round ${entry.round} ${entry.role} ${r.configId} ${r.set}: fully correct ${r.fullyCorrect}/${r.total}, right tool ${r.right}, valid ${r.valid}`);
  } else {
    const p = entry.proposal;
    const detail = [entry.decision.reason, p && `${p.scope} proposal on ${p.target} (${p.source}): ${p.rationale}`].filter(Boolean).join('. ');
    row = [time, entry.round, 'decision', '', '', entry.candidateId, entry.parentId, MODEL, '', runs, '', '', '', '', entry.decision.promote ? 'promote' : 'keep', detail];
    console.log(`round ${entry.round} decision: ${detail}`);
  }
  await appendFile(values.log, row.map(clean).join('\t') + '\n');
}

async function complete(messages) {
  const response = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', signal: AbortSignal.timeout(120_000), body: JSON.stringify({ model: MODEL, stream: false, messages, options: { temperature: 0.4, num_predict: 500 } }) });
  if (!response.ok) throw Error(`Ollama answered ${response.status}`);
  return (await response.json()).message?.content ?? '';
}

const { rows, toolsHash } = dumpTools();
const base = makeConfig({ parent: null, systemGuide: await readFile(new URL('../HOST-GUIDE.md', import.meta.url), 'utf8') });
await saveConfig(base);
let parent = values.from ? await loadConfig(values.from) : base;
console.log(`tools ${toolsHash} (${rows.length}), model ${MODEL}, runs ${runs}, margin ${margin}, start ${parent.id}${parent.id === base.id ? ' (HOST-GUIDE.md)' : ''}`);

const tasksFor = { dev: DEV_TASKS, 'held-out': HELDOUT_TASKS };
const score = (config, set) => scoreConfig({ config, set, tasks: tasksFor[set], rows, toolsHash, runs });

let exclude = new Set();
for (let round = firstRound; round < firstRound + rounds; round++) {
  const outcome = await runRound({ round, parent, score, propose, devTasks: DEV_TASKS, rows, complete: values['rule-only'] ? undefined : complete, exclude, margin, log });
  if (outcome.proposal) await saveConfig(outcome.proposal.config);
  if (outcome.decision.promote) exclude = new Set();
  else if (outcome.proposal) exclude.add(outcome.proposal.target);
  else break;
  parent = outcome.next;
}
console.log(`head ${parent.id}`);

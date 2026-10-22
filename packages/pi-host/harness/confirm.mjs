// Confirm a promotion before adopting it (docs/HARNESS-LOOP.md "Adopting a config"):
// score parent and candidate on the held-out set N times, interleaved so drift in the
// local model hits both equally, and report each run plus the mean and spread.
//   node harness/confirm.mjs <parent id> <candidate id> [--repeats 4] [--runs 3]
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { dumpTools, scoreConfig } from './runner.mjs';
import { HELDOUT_TASKS } from './tasks-heldout.mjs';
import { DEV_TASKS } from './tasks-dev.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { repeats: { type: 'string', default: '4' }, runs: { type: 'string', default: '3' }, set: { type: 'string', default: 'held-out' } } });
const [parentId, candidateId] = positionals;
const tasks = values.set === 'dev' ? DEV_TASKS : HELDOUT_TASKS;
const { rows, toolsHash } = dumpTools();
const configs = { parent: await loadConfig(parentId), candidate: await loadConfig(candidateId) };
const scores = { parent: [], candidate: [] };
for (let i = 0; i < Number(values.repeats); i++) {
  for (const role of i % 2 ? ['candidate', 'parent'] : ['parent', 'candidate']) {
    const result = await scoreConfig({ config: configs[role], set: values.set, tasks, rows, toolsHash, runs: Number(values.runs) });
    scores[role].push(result.fullyCorrect);
    console.log(`repeat ${i + 1} ${role} ${configs[role].id}: fully correct ${result.fullyCorrect}/${result.total}`);
  }
}
const stats = (xs) => ({ mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) });
console.log(JSON.stringify({ set: values.set, toolsHash, parent: { id: parentId, ...stats(scores.parent), runs: scores.parent }, candidate: { id: candidateId, ...stats(scores.candidate), runs: scores.candidate } }));

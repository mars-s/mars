// Harness loop (docs/HARNESS-LOOP.md) with a fake scorer and no model or network: the
// promotion rule, content-hash version binding, held-out isolation, and a mutation run
// proving the held-out regression refusal is what stops a bad promotion.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverrides, loadConfig, makeConfig, saveConfig, systemMessage } from './harness/config.mjs';
import { decide } from './harness/promotion.mjs';
import { buildEvidence, propose } from './harness/proposer.mjs';
import { runRound } from './harness/round.mjs';
import { scoreConfig } from './harness/runner.mjs';
import { DEV_TASKS } from './harness/tasks-dev.mjs';
import { HELDOUT_TASKS } from './harness/tasks-heldout.mjs';

const ROWS = [
  { name: 'host_exec', description: 'Run a bash command on the owner\'s machine and get its output.\nUse it for commands. Returns stdout and stderr and the exit code so you can see what happened.\nExample: await tools.host_exec({ command: "ls" })', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'The bash command to run, e.g. ls -la' } } }, output: { type: 'object', properties: {} } },
  { name: 'workspace_file_link', description: 'Get a download link for a workspace file, to give the owner in chat.\nUse it when the owner should download a file. Returns a url to put in a Markdown link in your reply.\nExample: await tools.workspace_file_link({ path: "exports/report.csv" })', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Path relative to the workspace, e.g. exports/a.csv' } } }, output: { type: 'object', properties: {} } },
];
const score = (configId, set, fullyCorrect, extra = {}) => ({ configId, set, model: 'm', toolsHash: 't', runs: 3, right: fullyCorrect, valid: fullyCorrect, fullyCorrect, total: 60, ...extra });
const scores = (dev, cand, heldParent, heldCand) => ({
  parentId: 'p', candidateId: 'c', parentDev: score('p', 'dev', dev), candidateDev: score('c', 'dev', cand),
  parentHeldOut: score('p', 'held-out', heldParent), candidateHeldOut: score('c', 'held-out', heldCand), margin: 2,
});

// Promotion rule.
assert.equal(decide(scores(30, 32, 20, 20)).promote, true, 'dev win at the margin with held-out equal promotes');
assert.equal(decide(scores(30, 35, 20, 23)).promote, true, 'dev win with held-out gain promotes');
const regress = decide(scores(30, 40, 20, 19));
assert.deepEqual([regress.promote, regress.heldOutDelta], [false, -1], 'held-out regression of one run refuses');
assert.match(regress.reason, /held-out fell by 1/);
const small = decide(scores(30, 31, 20, 25));
assert.deepEqual([small.promote, small.devGain], [false, 1], 'dev gain below the margin refuses, even with a held-out gain');
assert.equal(decide({ ...scores(30, 30, 20, 20) }).promote, false, 'a tie keeps the parent');
assert.throws(() => decide({ ...scores(30, 35, 20, 20), candidateHeldOut: score('p', 'held-out', 25) }), /offered as the score for c/, 'a held-out score from the parent cannot stand in for the candidate');
assert.throws(() => decide({ ...scores(30, 35, 20, 20), candidateDev: score('c', 'held-out', 35) }), /held-out score was offered as the dev score/, 'a held-out score cannot stand in for a dev score');
assert.throws(() => decide({ ...scores(30, 35, 20, 20), candidateHeldOut: score('c', 'held-out', 20, { toolsHash: 'other' }) }), /differ in toolsHash/, 'scores on different tool dumps are not compared');
assert.throws(() => decide({ ...scores(30, 35, 20, 20), candidateHeldOut: score('c', 'held-out', 20, { runs: 1, total: 20 }) }), /differ in runs/);
assert.throws(() => decide({ ...scores(30, 35, 20, 20), margin: 0 }), /margin/);

// Mutation run: the same rule without the held-out refusal must promote the regression above.
const source = await readFile(new URL('./harness/promotion.mjs', import.meta.url), 'utf8');
const guard = "  if (heldOutDelta < 0) return { promote: false, devGain, heldOutDelta, reason: `keep parent: held-out fell by ${-heldOutDelta}` };\n";
assert.ok(source.includes(guard), 'mutation target present in promotion.mjs');
const mutantFile = join(await mkdtemp(join(tmpdir(), 'mars-harness-mutant-')), 'promotion.mjs');
await writeFile(mutantFile, source.replace(guard, ''));
const mutant = await import(mutantFile);
assert.equal(mutant.decide(scores(30, 40, 20, 19)).promote, true, 'mutant without the held-out guard promotes a held-out regression, so the guard is what refuses it');

// Version binding.
const guide = '# Mars agent\n\nUse tools.';
const a = makeConfig({ systemGuide: guide, toolOverrides: { host_exec: 'x', workspace_file_link: 'y' } });
const b = makeConfig({ toolOverrides: { workspace_file_link: 'y', host_exec: 'x' }, systemGuide: guide });
assert.equal(a.id, b.id, 'same content gives the same id, whatever the key order');
assert.match(a.id, /^[0-9a-f]{12}$/);
assert.notEqual(makeConfig({ systemGuide: guide + ' ' }).id, makeConfig({ systemGuide: guide }).id, 'a one-character guide edit gives a new id');
assert.notEqual(makeConfig({ systemGuide: guide, toolOverrides: { host_exec: 'x!' } }).id, makeConfig({ systemGuide: guide, toolOverrides: { host_exec: 'x' } }).id, 'an override edit gives a new id');
assert.notEqual(makeConfig({ systemGuide: guide, parent: 'aaa' }).id, makeConfig({ systemGuide: guide, parent: 'bbb' }).id, 'the parent is part of the version');
assert.throws(() => { a.systemGuide = 'changed'; }, TypeError, 'a config cannot be edited in place');
const dir = await mkdtemp(join(tmpdir(), 'mars-harness-configs-'));
const file = await saveConfig(a, dir);
assert.deepEqual(await loadConfig(a.id, dir), a, 'a saved config loads back unchanged');
await saveConfig(a, dir);
const stored = JSON.parse(await readFile(file, 'utf8'));
await writeFile(file, JSON.stringify({ ...stored, contextNotes: 'edited by hand' }));
await assert.rejects(loadConfig(a.id, dir), /does not match its content/, 'a hand-edited config file is refused');
await assert.rejects(saveConfig(a, dir), /does not match its content/, 'saving over a tampered file is refused rather than ignored');

// Runs are bound to the config that produced them.
const over = makeConfig({ systemGuide: guide, contextNotes: 'Note.', toolOverrides: { workspace_file_link: 'Make a link.\nExample: await tools.workspace_file_link({ path: "a" })' } });
assert.equal(applyOverrides(ROWS, over)[1].description, over.toolOverrides.workspace_file_link);
assert.equal(applyOverrides(ROWS, over)[0].description, ROWS[0].description);
assert.throws(() => applyOverrides(ROWS, makeConfig({ systemGuide: guide, toolOverrides: { no_such_tool: 'x' } })), /unknown tool no_such_tool/);
const seen = [];
const fakeChat = async ({ system, user, tools }) => {
  seen.push({ system, user, link: tools.find((t) => t.function.name === 'workspace_file_link').function.description });
  return /link/.test(user) ? { name: 'workspace_file_link', args: { path: 'exports/report.csv' } } : { name: null, args: null };
};
const tasks = [
  { request: 'Give a link to exports/report.csv.', tool: 'workspace_file_link', wants: (x) => x.path === 'exports/report.csv' },
  { request: 'Run ls.', tool: 'host_exec', wants: () => true },
];
const run = await scoreConfig({ config: over, set: 'dev', tasks, rows: ROWS, toolsHash: 't', runs: 2, model: 'm', chat: fakeChat });
assert.deepEqual([run.configId, run.set, run.total, run.right, run.valid, run.fullyCorrect], [over.id, 'dev', 4, 2, 2, 2], 'the result names its config and counts');
assert.equal(seen[0].system, systemMessage(over));
assert.match(seen[0].system, /Note\.$/, 'context notes reach the system message');
assert.equal(seen[0].link, over.toolOverrides.workspace_file_link, 'the model is offered the overridden description');
assert.deepEqual(run.misses.map((m) => m.kind), ['no-call', 'no-call']);

// Held-out isolation, by source: the proposer and round code never import the held-out tasks.
for (const name of ['proposer.mjs', 'round.mjs', 'config.mjs', 'runner.mjs', 'promotion.mjs', 'tasks-dev.mjs']) {
  const text = await readFile(new URL(`./harness/${name}`, import.meta.url), 'utf8');
  assert.ok(!/tasks-heldout|HELDOUT/.test(text), `${name} does not reference the held-out tasks`);
}
const devText = new Set(DEV_TASKS.map((t) => t.request));
for (const task of HELDOUT_TASKS) assert.ok(!devText.has(task.request), `held-out request repeats a dev request: ${task.request}`);
assert.ok(DEV_TASKS.length >= 20 && HELDOUT_TASKS.length >= 12, 'dev has at least 20 tasks and held-out at least 12');

// Held-out isolation, by behaviour: a full round with a fake scorer whose every held-out
// result carries the held-out request text in its misses. Nothing the proposer receives,
// and nothing logged, may contain any held-out request.
const SECRET = HELDOUT_TASKS.map((t) => t.request);
const fakeScore = (fully) => async (config, set) => {
  const list = set === 'dev' ? DEV_TASKS : HELDOUT_TASKS;
  const fullyCorrect = fully(config, set);
  const misses = list.slice(fullyCorrect).map((task, i) => ({ task: fullyCorrect + i, run: 0, expected: task.tool, picked: null, args: { request: task.request }, kind: 'no-call' }));
  return { configId: config.id, set, model: 'm', toolsHash: 't', runs: 1, right: fullyCorrect, valid: fullyCorrect, fullyCorrect, total: list.length, misses };
};
const parentConfig = makeConfig({ systemGuide: '# Mars agent\n\nGuide.' });
const logged = [];
let received;
const spyPropose = async (input) => {
  received = input;
  return propose(input);
};
const leaks = (value) => SECRET.filter((text) => JSON.stringify(value).includes(text));
const fully = (config, set) => (config.id === parentConfig.id ? 10 : set === 'dev' ? 14 : 9);
const outcome = await runRound({ round: 1, parent: parentConfig, score: fakeScore(fully), propose: spyPropose, devTasks: DEV_TASKS, rows: ROWS, margin: 2, log: async (row) => logged.push(row) });
assert.ok(received, 'the proposer ran');
assert.deepEqual(leaks(received), [], 'the proposer receives no held-out request text');
assert.ok(JSON.stringify(received).includes(DEV_TASKS[10].request), 'the proposer does receive dev evidence');
assert.deepEqual(leaks(logged), [], 'no held-out request text is logged');
assert.equal(outcome.proposal.scope, 'general', 'all-no-call dev evidence gets the guide proposal');
assert.equal(outcome.proposal.config.parent, parentConfig.id, 'the candidate names its parent');
assert.deepEqual([outcome.decision.promote, outcome.next.id], [false, parentConfig.id], 'dev +4 with held-out -1 keeps the parent');
const decisionRow = logged.find((row) => row.kind === 'decision');
assert.deepEqual([decisionRow.parentId, decisionRow.candidateId], [parentConfig.id, outcome.proposal.config.id], 'the decision row binds both config ids');
assert.deepEqual(logged.filter((row) => row.kind === 'score').map((row) => [row.role, row.result.set, row.result.configId]), [
  ['parent', 'dev', parentConfig.id], ['parent', 'held-out', parentConfig.id], ['candidate', 'dev', outcome.proposal.config.id], ['candidate', 'held-out', outcome.proposal.config.id],
], 'each logged score is bound to the config that produced it');
const win = await runRound({ round: 2, parent: parentConfig, score: fakeScore((c, s) => (c.id === parentConfig.id ? 10 : s === 'dev' ? 14 : 10)), propose, devTasks: DEV_TASKS, rows: ROWS, margin: 2, log: async () => {} });
assert.deepEqual([win.decision.promote, win.next.id], [true, win.proposal.config.id], 'dev +4 with held-out equal promotes the candidate');

// Proposer: rejected targets are not proposed again, and tool rewrites must pass the tool rules.
const evidence = buildEvidence({ configId: parentConfig.id, total: 6, fullyCorrect: 3, misses: [
  { task: 0, run: 0, expected: 'workspace_file_link', picked: 'host_exec', args: {}, kind: 'wrong-tool' },
  { task: 0, run: 1, expected: 'workspace_file_link', picked: null, args: null, kind: 'no-call' },
  { task: 1, run: 0, expected: 'host_exec', picked: 'host_exec', args: {}, kind: 'bad-args' },
] }, [{ request: 'Link please.' }, { request: 'Run ls.' }]);
assert.equal(evidence.tools[0].tool, 'workspace_file_link');
const ruleTool = await propose({ parent: parentConfig, evidence, rows: ROWS });
assert.deepEqual([ruleTool.scope, ruleTool.target, ruleTool.source], ['tool', 'workspace_file_link', 'rule'], 'more wrong tools than prose answers gets a tool rewrite');
assert.ok(ruleTool.config.toolOverrides.workspace_file_link.includes('\nUse workspace_file_link, not host_exec, for requests like "Link please.".\nExample: await tools.workspace_file_link('), 'the rule rewrite names the wrong pick and the request, before the unchanged Example line');
const next = await propose({ parent: parentConfig, evidence, rows: ROWS, exclude: new Set(['workspace_file_link']) });
assert.equal(next.target, 'host_exec', 'a rejected target is skipped');
let calls = 0;
const badModel = async () => { calls++; return calls === 1 ? 'nope' : 'Use it often. '.repeat(120); };
const fallback = await propose({ parent: parentConfig, evidence, rows: ROWS, complete: badModel });
assert.deepEqual([calls, fallback.source], [2, 'rule'], 'a model rewrite that fails the tool rules gets one retry, then the rule-based rewrite');
assert.match(fallback.rationale, /failed the tool-quality rules twice \(description is \d+ chars; keep it under 1400\)/);
const guidance = 'Use it whenever the owner asks for a link to a file or wants to download it. Do not run a command for this.';
const modelTool = await propose({ parent: parentConfig, evidence, rows: ROWS, complete: async () => guidance });
assert.deepEqual([modelTool.source, modelTool.config.toolOverrides.workspace_file_link], ['local-model',
  `Get a download link for a workspace file, to give the owner in chat.\n${guidance}\nExample: await tools.workspace_file_link({ path: "exports/report.csv" })`], 'the model writes the guidance; the summary and Example lines are kept as they were');

console.log('PASS harness loop: promotion needs a dev win at the margin and no held-out loss (mutation without the held-out guard promotes a regression), configs are content-addressed and tamper-checked, runs and decisions name their config, and the proposer never sees held-out text');

// Forgiving arguments (docs/TOOLS.md): the common small-model slips are repaired before
// validation, and anything else still fails validation with a clear error.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { createOrchestrationExtension, forgivingList } from './orchestration.mjs';
import { createVmControl } from './vm-control.mjs';
import { createWorkflowExtension } from './workflows.mjs';

assert.deepEqual(forgivingList('[{"task":"a"}]', 'task'), [{ task: 'a' }], 'a JSON string becomes the array');
assert.deepEqual(forgivingList(['review a.ts', { task: 'b' }], 'task'), [{ task: 'review a.ts' }, { task: 'b' }], 'plain strings become objects');
assert.equal(forgivingList('not json', 'task'), 'not json', 'anything else passes through for validation to reject');

const models = { getModels: () => [], getModel: () => undefined };
const fanout = createOrchestrationExtension({ models, maxConcurrent: 4 }).tools.find((tool) => tool.name === 'worker_fanout');
const repaired = fanout.prepareArguments({ jobs: '["Review a.ts for bugs.", "Review b.ts for bugs."]' });
assert.ok(Compile(fanout.parameters).Check(repaired), 'worker_fanout accepts a JSON string of plain briefs');
assert.ok(!Compile(fanout.parameters).Check(fanout.prepareArguments({ jobs: 'review everything' })), 'an unrepairable value still fails validation');

const start = createWorkflowExtension({ models, loadImages: async () => ({}), abortTask: async () => {} }).tools.find((tool) => tool.name === 'workflow_start');
const steps = start.prepareArguments({ title: 'Post', steps: ['Research tide pools.', 'Write a post.'] });
assert.ok(Compile(start.parameters).Check(steps), 'workflow_start accepts plain step briefs');
assert.deepEqual(steps.steps.map((step) => step.title), ['Step 1', 'Step 2']);

assert.throws(() => start.prepareArguments({ steps: [{ step: 'Run tests', status: 'in_progress' }] }), /plan_update/, 'checklist steps sent to workflow_start point to plan_update');

// host_read given a saved-output id reads that output instead of failing on a missing file.
const root = mkdtempSync(join(tmpdir(), 'mars args '));
const vm = createVmControl({ root, cwd: root });
const exec = vm.extension.tools.find((tool) => tool.name === 'host_exec');
const ran = (await exec.execute({ command: 'echo saved-output-text' }, {}, {})).structuredOutput;
const hostRead = vm.extension.tools.find((tool) => tool.name === 'host_read');
assert.match((await hostRead.execute({ path: ran.stdout.id }, {}, {})).structuredOutput.text, /saved-output-text/, 'host_read reads a saved output by id');
writeFileSync(join(root, 'plain.txt'), 'a real file');
assert.equal((await hostRead.execute({ path: 'plain.txt' }, {}, {})).structuredOutput.text, 'a real file', 'and still reads real files');
console.log('PASS tool arguments: JSON-string and plain-string lists repaired for worker_fanout and workflow_start, unrepairable values still rejected, checklist sent to workflow_start redirected to plan_update, host_read accepts a saved-output id');

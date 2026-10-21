// Every installed tool meets the tool-quality bar (tool-quality.mjs, docs/TOOLS.md). Boots the
// real host in dump mode so the check sees exactly what the model is offered, including
// the self-deploy tools that staging leaves out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToolSample } from '@earendil-works/pi-codemode/declarations';
import { UPSTREAM_TOOLS, toolProblems } from './tool-quality.mjs';

const base = mkdtempSync(join(tmpdir(), 'mars tools '));
const out = join(base, 'tools.json');
const run = spawnSync(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  cwd: base,
  env: { ...process.env, MARS_PI_ROOT: join(base, 'data'), MARS_PI_PORT: '39181', MARS_UI_PORT: '39182', MARS_PI_STAGING: '1', MARS_DUMP_TOOLS: out },
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(run.status, 0, 'host dumps its tools: ' + run.stderr.slice(-1500));
const tools = JSON.parse(readFileSync(out, 'utf8'));
assert.ok(tools.length >= 40, `expected the full catalogue, got ${tools.length}`);

const names = tools.map((tool) => tool.name);
assert.equal(new Set(names).size, names.length, 'tool names are unique');
const failures = tools.flatMap((tool) => toolProblems(tool).map((problem) => `${tool.extension}/${tool.name}: ${problem}`));
if (process.env.MARS_TOOL_REPORT) {
  for (const tool of tools.filter((t) => !UPSTREAM_TOOLS.has(t.name)))
    console.log(`\n==== ${tool.name}\n` + renderToolSample({ name: tool.name, description: tool.description, inputSchema: tool.parameters, outputSchema: tool.output ?? { type: 'string' } }));
}
if (failures.length) {
  console.error(`${failures.length} tool-quality problems:\n- ` + failures.join('\n- '));
  process.exit(1);
}
const ours = tools.filter((tool) => !UPSTREAM_TOOLS.has(tool.name));
const fields = ours.reduce((sum, tool) => sum + Object.keys(tool.parameters?.properties ?? {}).length, 0);
console.log(`PASS tool quality: ${ours.length} Mars tools (${fields} top-level fields) each start with a verb, say when to use them, describe every field, type their result and show an example; ${tools.length - ours.length} upstream tools present`);

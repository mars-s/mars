// The tool-quality linter catches each defect it exists for, and passes a good tool.
import assert from 'node:assert/strict';
import { Type } from '@earendil-works/pi-ai';
import { toolProblems } from './tool-quality.mjs';

const good = {
  name: 'demo_tool',
  description: 'Open a demo thing for the owner.\nUse it when you need a demo. It returns the new id at once; pass it to demo_send next.\nExample: await tools.demo_tool({ title: "Hello", count: 2 })',
  parameters: Type.Object({ title: Type.String({ description: 'Name shown in the sidebar.' }), count: Type.Optional(Type.Integer({ minimum: 1, description: 'How many to make, at least 1.' })) }),
  output: Type.Object({ id: Type.String({ description: 'The id.' }) }),
};
assert.deepEqual(toolProblems(good), [], 'a good tool passes');
const defects = {
  'starts with a verb': { ...good, description: 'the demo tool.\n' + good.description.split('\n').slice(1).join('\n') },
  '"Example:" line': { ...good, description: good.description.split('\nExample')[0] + ' Padding text so the length rule is not what fails here.' },
  'must call tools.demo_tool': { ...good, description: good.description.replace('tools.demo_tool(', 'tools.other(') },
  'literal object': { ...good, description: good.description.replace('"Hello"', 'name') },
  'do not match the input schema': { ...good, description: good.description.replace('count: 2', 'count: 0') },
  'needs a description': { ...good, parameters: Type.Object({ title: Type.String() }) },
  'structuredOutputSchema': { ...good, output: Type.Any() },
  'jargon': { ...good, description: good.description.replace('for the owner', 'as a durable record') },
};
for (const [expected, tool] of Object.entries(defects))
  assert.ok(toolProblems(tool).some((problem) => problem.includes(expected.replace(/^"|"$/g, '').replace('starts with a verb', 'start with a verb'))), `catches: ${expected} -> ${JSON.stringify(toolProblems(tool))}`);
assert.deepEqual(toolProblems({ name: 'bash', description: 'upstream' }), [], 'upstream tools keep their own wording');
console.log(`PASS tool-quality rules: a good tool passes and each of ${Object.keys(defects).length} defects is caught`);

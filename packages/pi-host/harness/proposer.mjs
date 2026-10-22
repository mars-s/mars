// Proposes one candidate harness config from dev-set evidence (docs/HARNESS-LOOP.md).
// This module must never import the held-out tasks; check-harness-loop.mjs enforces it.
// Two scoped proposers, as in Harness²: a general one that edits the system guide when
// the model answers in prose instead of calling a tool, and a tool one that rewrites the
// description of the tool with the most misses. For a tool rewrite the local model writes
// only the middle guidance; the code keeps the first line and the Example line, because a
// 1.5B model asked for the whole description dropped both in every try. The result must
// pass the tool-quality rules, gets one retry with the problem, then falls back to a fixed
// rule-based sentence.
import { toolProblems } from '../tool-quality.mjs';
import { makeConfig } from './config.mjs';

export const ANSWER_WITH_A_TOOL = [
  '## Answering',
  '',
  'When a request needs an action, a lookup, a file or a link, call the tool that does it',
  'first. Do not describe the call or invent its result, such as a link or a page you have',
  'not fetched. Answer in plain text only when no tool fits the request.',
].join('\n');

/** Dev misses grouped for a proposer: per expected tool, what went wrong, with the request text. */
export function buildEvidence(devResult, devTasks) {
  const byTool = new Map();
  for (const miss of devResult.misses) {
    const entry = byTool.get(miss.expected) ?? { tool: miss.expected, misses: 0, kinds: {}, examples: [] };
    entry.misses++;
    entry.kinds[miss.kind] = (entry.kinds[miss.kind] ?? 0) + 1;
    if (entry.examples.length < 4) entry.examples.push({ request: devTasks[miss.task].request, kind: miss.kind, picked: miss.picked, args: miss.args });
    byTool.set(miss.expected, entry);
  }
  const tools = [...byTool.values()].sort((a, b) => b.misses - a.misses || a.tool.localeCompare(b.tool));
  const kinds = { 'no-call': 0, 'wrong-tool': 0, 'bad-args': 0 };
  for (const miss of devResult.misses) kinds[miss.kind]++;
  return { configId: devResult.configId, total: devResult.total, fullyCorrect: devResult.fullyCorrect, kinds, tools };
}

const lineOf = (example) => `- "${example.request}" -> ${example.kind === 'no-call' ? 'answered in text, no tool call' : example.kind === 'wrong-tool' ? `called ${example.picked}` : `called it with ${JSON.stringify(example.args)?.slice(0, 160)}`}`;

function generalProposal(parent, evidence, exclude) {
  const noCall = evidence.kinds['no-call'];
  const missed = evidence.total - evidence.fullyCorrect;
  if (exclude.has('systemGuide') || !missed || noCall * 2 < missed || parent.systemGuide.includes(ANSWER_WITH_A_TOOL)) return null;
  const [title, ...rest] = parent.systemGuide.split('\n');
  const systemGuide = [title, '', ANSWER_WITH_A_TOOL, ...rest].join('\n');
  return {
    config: makeConfig({ ...parent, parent: parent.id, systemGuide }),
    scope: 'general', target: 'systemGuide', source: 'rule',
    rationale: `${noCall} of ${missed} dev misses on ${parent.id} were plain-text answers with no tool call; added an "Answering" paragraph at the top of the guide`,
  };
}

const REWRITE_SYSTEM = [
  'You write guidance for one tool so that a small model picks it, with the right arguments, for requests like the ones listed.',
  'Write two to four plain sentences: when to use this tool, which argument holds what from the request, and which other tool to use instead when that fits.',
  'Do not repeat the summary line or the example. Under 700 characters. Reply with only the sentences, no preamble, no list and no code fence.',
].join('\n');

const exampleLine = (description) => description.match(/^Example: .*$/m)?.[0];
const firstLine = (description) => description.split('\n')[0];
const assemble = (row, guidance) => [firstLine(row.description), guidance, exampleLine(row.description)].filter(Boolean).join('\n');

export function rewriteProblems(row, description) {
  const problems = toolProblems({ ...row, description });
  const example = exampleLine(row.description);
  if (example && !description.includes(example)) problems.push(`the line "${example}" must stay exactly as given`);
  if (firstLine(description) !== firstLine(row.description)) problems.push('the summary line must stay as given');
  return problems;
}

async function modelRewrite(row, entry, complete) {
  const user = [
    `Tool: ${row.name}`, `Summary line (kept): ${firstLine(row.description)}`, `Example (kept): ${exampleLine(row.description) ?? 'none'}`,
    'Current guidance:', row.description.split('\n').slice(1).filter((line) => !line.startsWith('Example: ')).join('\n'), '',
    `Requests that should use ${row.name} but went wrong:`, ...entry.examples.map(lineOf),
  ].join('\n');
  let messages = [{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }];
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = (await complete(messages)).trim().replace(/^```\w*\n?|\n?```$/g, '').trim().replace(/\n+/g, ' ');
    const description = assemble(row, text);
    problems = text.length < 40 ? ['the reply is under 40 characters; write two to four sentences'] : rewriteProblems(row, description);
    if (!problems.length) return { description, attempts: attempt + 1 };
    messages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: `That fails these rules: ${problems.join('; ')}. Reply with the corrected sentences only.` }];
  }
  return { problems };
}

/** A sentence naming the dev requests this tool should have taken, inserted before the Example line. */
function ruleRewrite(row, entry) {
  const asks = entry.examples.map((example) => `"${example.request}"`).filter((value, index, all) => all.indexOf(value) === index).slice(0, 2);
  const wrong = entry.examples.find((example) => example.kind === 'wrong-tool')?.picked;
  const sentence = `Use ${row.name}${wrong ? `, not ${wrong},` : ''} for requests like ${asks.join(' or ')}.`;
  const example = exampleLine(row.description);
  const description = example ? row.description.replace(example, `${sentence}\n${example}`) : `${row.description}\n${sentence}`;
  return rewriteProblems(row, description).length ? null : description;
}

async function toolProposal(parent, evidence, rows, complete, exclude) {
  const tried = new Set([...Object.keys(parent.toolOverrides), ...exclude]);
  const entry = evidence.tools.find((candidate) => candidate.tool && !tried.has(candidate.tool) && rows.some((row) => row.name === candidate.tool));
  if (!entry) return null;
  const row = rows.find((candidate) => candidate.name === entry.tool);
  let source = 'local-model';
  let note = '';
  let description;
  if (complete) {
    const rewrite = await modelRewrite(row, entry, complete);
    description = rewrite.description;
    if (!description) note = `; local model rewrite failed the tool-quality rules twice (${rewrite.problems.join('; ')})`;
  }
  if (!description) {
    source = 'rule';
    description = ruleRewrite(row, entry);
  }
  if (!description) return null;
  return {
    config: makeConfig({ ...parent, parent: parent.id, toolOverrides: { ...parent.toolOverrides, [row.name]: description } }),
    scope: 'tool', target: row.name, source,
    rationale: `${row.name} had ${entry.misses} dev misses on ${parent.id} (${Object.entries(entry.kinds).map(([kind, count]) => `${count} ${kind}`).join(', ')}); rewrote its description${note}`,
  };
}

/**
 * One candidate from the parent and dev evidence, or null to keep the parent.
 * `complete(messages)` returns the local model's text; omit it for rule-based proposals only.
 * `exclude` holds targets ('systemGuide' or a tool name) already rejected from this parent.
 */
export async function propose({ parent, evidence, rows, complete, exclude = new Set() }) {
  return generalProposal(parent, evidence, exclude) ?? toolProposal(parent, evidence, rows, complete, exclude);
}

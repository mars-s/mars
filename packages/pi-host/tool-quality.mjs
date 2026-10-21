// Tool-quality rules (docs/TOOLS.md). Every tool the model can call is written so a small
// model can use it from the declaration alone: what it is for, when to use it instead of a
// neighbour, every field explained, a typed result, and one worked example. These rules
// run against the real installed definitions in check-tool-quality.mjs, so a new or edited
// tool that falls below the bar fails the gate.

// Tools whose wording is owned upstream (Pi Durable and the coding agent). They are
// checked for presence only; their text is not ours to rewrite.
import { Compile } from 'typebox/compile';

export const UPSTREAM_TOOLS = new Set(['codemode', 'tool_search', 'read', 'write', 'edit', 'bash']);

const JARGON = /\b(native|task-owned|bounded|immutable|lexical|durable|persisted|exposure)\b/i;

/** Every property path in a JSON schema, with its schema. */
export function schemaFields(schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    out.push({ path: path + key, schema: value });
    if (value.type === 'object') out.push(...schemaFields(value, `${path}${key}.`));
    if (value.type === 'array' && value.items?.type === 'object') out.push(...schemaFields(value.items, `${path}${key}[].`));
  }
  return out;
}

/** The text between `tools.<name>(` and its matching `)`, skipping brackets inside strings. */
function callArguments(example, name) {
  const head = `tools.${name}(`;
  const open = example.indexOf(head);
  if (open < 0) return undefined;
  let depth = 0;
  let quote = '';
  for (let i = open + head.length; i < example.length; i++) {
    const char = example[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('({['.includes(char)) depth++;
    else if (')}]'.includes(char)) {
      if (depth === 0) return example.slice(open + head.length, i).trim();
      depth--;
    }
  }
  return undefined;
}

/**
 * The example call's argument object, evaluated as a plain literal: any variable in it
 * throws, so it must be copyable as written. `check` (a compiled schema) validates it.
 * Returns undefined when it is not a literal, `{ error }` when it fails the schema.
 */
export function exampleArguments(example, name, check) {
  const source = callArguments(example, name);
  if (source === undefined) return undefined;
  let value;
  try {
    // A Proxy scope turns every free identifier into a ReferenceError.
    const scope = new Proxy({}, { has: () => true, get: (_target, key) => { if (key === Symbol.unscopables) return undefined; throw new ReferenceError(String(key)); } });
    value = Function('scope', `with (scope) { return (${source}); }`)(scope);
  } catch {
    return undefined;
  }
  if (check && !check.Check(value)) {
    const [first] = check.Errors(value);
    return { error: `${first?.instancePath || 'root'} ${first?.message ?? 'is invalid'}` };
  }
  return { value };
}

/** Problems with one tool definition, as plain sentences. Empty when it meets the bar. */
export function toolProblems(tool) {
  if (UPSTREAM_TOOLS.has(tool.name)) return tool.description ? [] : ['has no description'];
  const problems = [];
  const description = tool.description ?? '';
  const firstLine = description.split('\n')[0];
  if (!/^[A-Z][a-z]+\b/.test(firstLine)) problems.push('description should start with a verb, e.g. "Open ..." or "List ..."');
  if (firstLine.length > 140) problems.push(`first line is ${firstLine.length} chars; keep the one-line summary under 140 (tool_search shows only this line)`);
  if (description.length < 120) problems.push(`description is ${description.length} chars; say what it is for, when to use it and what it returns`);
  if (description.length > 1400) problems.push(`description is ${description.length} chars; keep it under 1400`);
  const example = description.match(/^Example: .*$/m)?.[0];
  if (!example) problems.push('description needs an "Example:" line showing a real call');
  else {
    if (!example.includes(`tools.${tool.name}(`)) problems.push(`example must call tools.${tool.name}(...)`);
    const args = exampleArguments(example, tool.name, tool.parameters ? Compile(tool.parameters) : undefined);
    if (args === undefined) problems.push('example arguments must be a literal object (no variables), so it can be checked and copied');
    else if (args.error) problems.push(`example arguments do not match the input schema: ${args.error}`);
  }
  if (JARGON.test(description)) problems.push(`description uses jargon "${description.match(JARGON)[0]}"; say what it means in plain words`);
  for (const field of schemaFields(tool.parameters)) {
    const text = field.schema.description;
    if (typeof text !== 'string' || text.trim().length < 12) problems.push(`field "${field.path}" needs a description (what it is, units, default)`);
  }
  const output = tool.output;
  const opaque = !output || output.type === undefined && !output.anyOf && !output.properties;
  if (opaque) problems.push('needs a structuredOutputSchema describing the result (not Type.Any())');
  return problems;
}

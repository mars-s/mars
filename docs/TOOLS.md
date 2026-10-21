# Writing Mars tools

Mars agent tools are written so a small model can use them correctly from what it is
shown and nothing else. A model meets a tool in one of three ways, and each must be
enough on its own:

- `tool_search` results show the name and the **first line** of the description.
- The codemode section and `describeTool()` show the description and a TypeScript
  declaration rendered from the schemas. Each field's `description` becomes a comment
  above that field.
- A direct tool call shows the description and the JSON schema.

`packages/pi-host/tool-quality.mjs` encodes the rules below and
`check-tool-quality.mjs` runs them against every installed tool, so the gate fails when
a tool falls short. Upstream tools (`codemode`, `tool_search`, `read`, `write`,
`edit`, `bash`) keep their upstream wording.

## Description

1. **First line: a verb and the outcome**, under 140 characters. "Open a side chat
   nested under this conversation." It is the only line `tool_search` shows.
2. **When to use it, and when to use a neighbour instead.** Name the neighbour:
   "To wait for an answer, use worker_run instead."
3. **What it returns**, in words, and what to do next with it ("pass `id` to
   side_chat_send").
4. **Limits and failure** that change what the caller does: caps, what is refused, what
   happens on interruption.
5. **`Example:`** one real call in codemode form, with realistic values:
   `await tools.side_chat_open({ title: "Name ideas", task: "Suggest three names" })`.
6. Plain words. Say "kept after a restart" rather than "durable"; "up to 16 KiB"
   rather than "bounded".

## Fields

Every field has a `description` of at least a short sentence: what it is, its unit,
its default, and an example value when the format is not obvious ("Path relative to
the workspace, e.g. `notes/plan.md`"). Enumerations use literal unions so the
declaration lists the choices. Defaults use `default` so the declaration shows
`@default`.

## Result

Every tool declares `structuredOutputSchema` with the real shape, so codemode scripts
see `Promise<{ id: string; ... }>` rather than `unknown`. Describe each result field the
caller acts on. Errors throw with a sentence that says what to do differently.

## Forgiving arguments

Small models make the same few slips. Tools repair the safe ones with
`prepareArguments` before validation, and still reject anything else:

- A JSON string where an array belongs, and plain strings where objects belong
  (`worker_fanout` jobs, `workflow_start` steps).
- A saved-output id passed to `host_read` as a path reads that saved output.

`check-tool-arguments.mjs` proves each repair and that unrepairable values still fail.

## Measuring it

Write a description, then check it against a small model rather than by eye. The
evaluation sends each request to a local 1.5B model with every Mars tool offered, five
times per request, and grades the chosen tool, schema-valid arguments and the intent
of the arguments. Re-run it after changing tool wording; it needs Ollama with
`qwen2.5:1.5b` and costs nothing.

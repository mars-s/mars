// The agent's own checklist for multi-step work (docs/TOOLS.md "plan_update"). Pi stores
// it per conversation in a native document, so it survives a restart and the UI reads
// the same plan the agent wrote.
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';

export const PlanDoc = defineDoc({ kind: 'mars.plan', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ steps: [] }) });
export const PLAN_LIMIT = 20;
const STATUSES = ['pending', 'in_progress', 'completed'];
const ALIASES = { todo: 'pending', not_started: 'pending', doing: 'in_progress', active: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', done: 'completed', complete: 'completed', finished: 'completed' };

/** Plan summary: the steps, how many are done, and the first step not yet done. */
export function planView(steps) {
  const done = steps.filter((step) => step.status === 'completed').length;
  return { steps, done, total: steps.length, next: steps.find((step) => step.status !== 'completed')?.step ?? null };
}

/**
 * Forgiving input: a JSON string, plain strings (pending steps), common status words
 * ("done", "doing") and `text`/`title`/`content` for the step all become the documented
 * shape. Validation still rejects anything else.
 */
export function preparePlan(args) {
  let steps = args?.steps ?? args?.plan;
  if (typeof steps === 'string') try { steps = JSON.parse(steps); } catch { return args; }
  if (!Array.isArray(steps)) return args;
  return {
    steps: steps.map((item) => {
      if (typeof item === 'string') return { step: item, status: 'pending' };
      if (!item || typeof item !== 'object') return item;
      const step = item.step ?? item.text ?? item.title ?? item.content;
      const raw = typeof item.status === 'string' ? item.status.trim().toLowerCase() : item.status;
      return { step, status: ALIASES[raw] ?? raw ?? 'pending' };
    }).map((item) => (item && typeof item.step === 'string' ? { ...item, step: item.step.trim() } : item)),
  };
}

const Step = Type.Object({
  step: Type.String({ minLength: 1, maxLength: 200, description: 'What this step does, short and concrete, e.g. "Run the tests".' }),
  status: Type.Union(STATUSES.map((status) => Type.Literal(status)), { description: '"pending" not started, "in_progress" doing it now (at most one), "completed" done.' }),
});

export function createPlanExtension() {
  return defineExtension({
    name: 'mars-plan',
    tools: [
      defineTool({
        name: 'plan_update',
        description: `Show the owner your step-by-step plan, and tick steps off as you do them.
Use it whenever a task takes three or more steps that you will do yourself in this chat. Always send EVERY step of the plan, in order, every time: it replaces the whole checklist. Statuses: steps you have finished are "completed", the one step you are doing now is "in_progress", the rest are "pending". Call it again each time you finish a step. It runs nothing: it only updates the checklist the owner sees. For steps that helper models should run one after another, use workflow_start; for independent jobs at once, use worker_fanout. Send { steps: [] } to clear it.
Example: await tools.plan_update({ steps: [{ step: "Find the video in the PR", status: "completed" }, { step: "Add the player to the page", status: "in_progress" }, { step: "Check it plays", status: "pending" }] })
`,
        parameters: Type.Object({
          steps: Type.Array(Step, { maxItems: PLAN_LIMIT, description: `Every step of the plan, in order, up to ${PLAN_LIMIT}: finished ones "completed", the current one "in_progress", the rest "pending". An empty list clears it.` }),
        }),
        structuredOutputSchema: Type.Object({
          steps: Type.Array(Step, { description: 'The plan as saved.' }),
          done: Type.Integer({ description: 'How many steps are completed.' }),
          total: Type.Integer({ description: 'How many steps there are.' }),
          next: Type.Union([Type.String(), Type.Null()], { description: 'The first step not completed yet, or null when all are done.' }),
        }),
        prepareArguments: preparePlan,
        deferred: true,
        replay: 'safe',
        execute: async (args, api, ctx) => {
          if (args.steps.filter((step) => step.status === 'in_progress').length > 1)
            throw Error('Only one step can be "in_progress" at a time. Mark the others "pending" or "completed".');
          // preparePlan trimmed each step before validation, so a blank step was already refused.
          const steps = args.steps.map(({ step, status }) => ({ step, status }));
          await api.commit(async (tx) => {
            (await tx.doc(PlanDoc, api.conversationId)).steps = steps;
          }, ctx);
          const value = planView(steps);
          return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
        },
      }),
    ],
  });
}

/** The conversation's current plan, for /api/state. Read-only. */
export async function readPlan(harness, conversationId, context) {
  const doc = await harness.snapshot(PlanDoc, conversationId, context);
  return doc?.steps?.length ? planView(doc.steps) : null;
}

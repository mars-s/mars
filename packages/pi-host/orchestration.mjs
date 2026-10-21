import { Type } from '@earendil-works/pi-ai';
import { configure, defineExtension, defineTask, defineTool, UsageDoc, AgentDoc, LiveDoc, defineDoc } from '@earendil-works/pi-durable';
import { isArchived } from './organise-doc.mjs';

export const nativeTitleDoc = defineDoc({ kind: 'mars.conversation-title', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '' }) });
const nativeId = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const aliases = { sol: ['openai', 'gpt-6-sol'], luna: ['openai', 'gpt-6-luna'], astra: ['openai', 'gpt-6-astra'], opus: ['anthropic', 'claude-opus-4-8'] };
const compact = messages => messages.filter(m => m.role === 'assistant').at(-1)?.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 4000) || '';
const receiptOf = (task, id) => task?.state.outcome?.result?.find?.(row => row.id === id) || (task?.state.outcome?.result?.steps || task?.state.checkpoint?.steps)?.find(row => row.conversationId === String(id));
const output = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });

/**
 * Forgiving list arguments: models often send a JSON string where an array belongs, or
 * plain strings where objects belong. Both are turned into the documented shape before
 * validation; anything else is passed through for the schema to reject.
 */
export function forgivingList(value, field) {
  let list = value;
  if (typeof list === 'string') try { list = JSON.parse(list); } catch { return value; }
  return Array.isArray(list) ? list.map((item) => (typeof item === 'string' ? { [field]: item } : item)) : value;
}

export function selectWorkerModel(models, job) {
  const pair = aliases[job.model || 'luna'];
  const provider = job.provider || pair?.[0];
  let modelId = job.modelId || pair?.[1];
  if (!job.modelId && job.model === 'sol' && models.getModel(provider, 'gpt-6.1-sol')) modelId = 'gpt-6.1-sol';
  if (!job.modelId && job.model === 'opus') modelId = models.getModels(provider).filter(m => /opus/i.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0]?.id || modelId;
  if (!provider || !modelId || !models.getModel(provider, modelId)) throw new Error(`Unavailable worker model ${job.model || modelId}`);
  return { provider, modelId };
}

/** All admission, ownership, replay and cancellation belong to Pi's scheduler. */
export function createOrchestrationExtension({ models, maxConcurrent = 4, loadImages }) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error('maxConcurrent must be 1..32');
  const workflow = defineTask({
    name: 'mars.worker-workflow', version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, ctx) => runtime.commit(async tx => {
        const children = [];
        const owner = task.owner ? await tx.task(task.owner) : undefined;
        for (const job of task.input.jobs) {
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
          await configure(tx, child.id, { model: job.selection });
          const label = await tx.doc(nativeTitleDoc, child.id);
          label.title = (job.title?.trim() || job.task.trim()).slice(0, 160);
          label.task = job.task;
          if (owner?.input?.assistant !== undefined) label.parentEntryId = String(owner.input.assistant);
          children.push(child.id);
        }
        return { status: 'running', checkpoint: { phase: 'run', children } };
      }, ctx),
      run: async (task, runtime, ctx) => {
        const results = await Promise.all(task.state.checkpoint.children.map(async (id, index) => {
          const child = await runtime.conversation(id, ctx);
          const job = task.input.jobs[index];
          // Image IO happens outside the prepare transaction and only for explicit references.
          const images = job.attachmentIds?.length ? await loadWorkerImages(job) : undefined;
          const settled = await (await child.submit({ type: 'input', content: images?.content || job.task, ...(images ? { entry: { kind: 'mars.user', data: { attachments: images.attachments } } } : {}), requestId: `worker:${runtime.taskId}:${index}` }, ctx)).wait(ctx);
          const view = await runtime.context(id, ctx);
          return { id, conversationId: id, ...task.input.jobs[index].selection, status: settled.status === 'done' ? 'completed' : (settled.reason === 'aborted' ? 'aborted' : 'unanswered'), result: compact(view.messages), usage: await runtime.snapshot(UsageDoc, id, ctx) || { models: {}, tools: {} } };
        }));
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: results } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
  async function loadWorkerImages(job) {
    if (!loadImages) throw new Error('Worker image loading is unavailable');
    return loadImages(job.attachmentIds, job.task);
  }
  const job = Type.Object({
    task: Type.String({ minLength: 1, description: 'Everything the worker needs, as a complete brief: it does not see this conversation. E.g. "Summarise the README in notes/ in five bullet points."' }),
    title: Type.Optional(Type.String({ maxLength: 160, description: 'Short name shown in the sidebar, e.g. "Summarise README".' })),
    model: Type.Optional(Type.Union([Type.Literal('luna'), Type.Literal('sol'), Type.Literal('astra'), Type.Literal('opus')], { default: 'luna', description: 'luna: fast and cheap, for simple jobs (default). sol: strong all-rounder. astra: hardest reasoning. opus: Claude, for writing and long careful work.' })),
    provider: Type.Optional(Type.String({ description: 'Advanced: exact provider, e.g. "openai". Use with modelId instead of model.' })),
    modelId: Type.Optional(Type.String({ description: 'Advanced: exact model id, e.g. "gpt-6-sol". Use with provider instead of model.' })),
    attachmentIds: Type.Optional(Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { maxItems: 4, description: 'Ids of images from this chat to show the worker, up to 4. Needs a model that reads images.' })),
  });
  const WorkerResult = Type.Object({
    id: Type.String({ description: 'Worker id. Pass it to worker_followup or worker_stop.' }),
    conversationId: Type.String({ description: 'The worker conversation id.' }),
    provider: Type.String({ description: 'Provider used.' }),
    modelId: Type.String({ description: 'Model used.' }),
    status: Type.String({ description: '"completed", "aborted" or "unanswered".' }),
    result: Type.String({ description: "The worker's final answer, up to 4000 characters." }),
    usage: Type.Any({ description: 'Token use, by model.' }),
  });
  const RunOutcome = Type.Object({
    status: Type.String({ description: '"completed" when every worker finished, or "aborted".' }),
    result: Type.Optional(Type.Array(WorkerResult, { description: 'One entry per worker, in the order given.' })),
  }, { additionalProperties: true });
  const tools = [];
  function tool(name, description, parameters, result, execute, prepareArguments) {
    tools.push(defineTool({ name, description, parameters, structuredOutputSchema: result, deferred: true, replay: 'safe', executionMode: 'parallel', ...(prepareArguments ? { prepareArguments } : {}), execute: async (args, api, ctx) => output(await execute(args, api, ctx)) }));
  }
  async function run(jobs, api, ctx) {
    if (!jobs.length || jobs.length > maxConcurrent) throw new Error(`Use 1..${maxConcurrent} workers per fanout`);
    const inputs = jobs.map(j => ({ ...j, selection: selectWorkerModel(models, j) }));
    for (const job of inputs) if (job.attachmentIds?.length && !models.getModel(job.selection.provider, job.selection.modelId)?.input?.includes('image')) throw new Error('Selected worker model does not support images');
    const taskId = await api.memo('workflow', ctx) || await api.commit(async tx => {
      let cursor;
      do {
        const page = await tx.scanTasks({ conversationId: api.conversationId, kind: workflow.definition.name }, 100, cursor);
        const existing = page.items.find(t => t.owner === api.taskId);
        if (existing) return existing.id;
        cursor = page.next;
      } while (cursor);
      return await tx.createTask(workflow, { jobs: inputs }, { ownership: { kind: 'task', taskId: api.taskId } });
    }, ctx);
    await api.memo('workflow', taskId, ctx);
    await api.details({ workerTaskId: taskId }, ctx);
    return (await api.waitForTask(taskId, ctx)).state.outcome;
  }
  tool('worker_run', `Hand one job to a helper model and wait for its answer.
Use it for ONE self-contained job, with a different model, or to keep a long investigation out of this conversation. For several steps in order, use workflow_start. The worker sees only task (and any images you pass), not this chat, so write task as a complete brief. It waits until the worker finishes and returns its final answer in result[0].result. It shows nested under this chat, and survives a restart. For several independent jobs at once, use worker_fanout; for work the owner should follow, use side_chat_open.
Example: const { result } = await tools.worker_run({ task: "List the TODO comments in src/ with file and line.", model: "luna", title: "Find TODOs" })`, job, RunOutcome, (args, api, ctx) => run([args], api, ctx));
  tool('worker_fanout', `Run two or more jobs at the same time, each by its own helper model, and wait for all their answers.
Use it whenever there are several independent jobs, e.g. reviewing three files or researching three options: put one entry per job in jobs. For a single job, use worker_run. Each job is a worker as in worker_run, with its own complete brief. Returns one result per job, in the same order. Up to ${maxConcurrent} jobs per call. For steps that must run in order, use workflow_start.
Example: const { result } = await tools.worker_fanout({ jobs: [{ task: "Review a.ts for bugs." }, { task: "Review b.ts for bugs." }] })`, Type.Object({ jobs: Type.Array(job, { minItems: 1, maxItems: maxConcurrent, description: `The jobs, 1 to ${maxConcurrent}. Each needs its own complete task.` }) }), RunOutcome, (args, api, ctx) => run(args.jobs, api, ctx), (args) => ({ ...args, jobs: forgivingList(args?.jobs, 'task') }));
  async function workerRecords(api, ctx) {
    return api.commit(async tx => {
      const rows = [];
        const page = await tx.scanConversations({ ownerConversationId: api.conversationId, order: 'descending' }, 100);
        for (const child of page.items) {
          const owner = await tx.task(child.owner.taskId);
          const label = await tx.doc(nativeTitleDoc, child.id);
          if (label.workflowId) continue;
          rows.push({ id: String(child.id), conversationId: String(api.conversationId), childConversationId: String(child.id), title: label.title || 'Worker', task: label.task, workflowId: label.workflowId, taskKind: label.taskKind, parentEntryId: label.parentEntryId, status: owner?.state.outcome?.status || owner?.state.status || 'unknown', result: owner?.state.outcome?.result?.find?.(item => item.id === child.id)?.result });
        }
      return rows.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
    }, ctx);
  }
  async function ownedWorker(id, api, ctx) {
    const record = await api.commit(tx => tx.conversation(nativeId(id)), ctx);
    if (record?.owner?.conversationId !== api.conversationId) throw new Error('Worker not found for this conversation');
    return api.conversation(nativeId(id), ctx);
  }
  const WorkerRow = Type.Object({
    id: Type.String({ description: 'Worker id for worker_followup or worker_stop.' }),
    title: Type.String({ description: 'Short name.' }),
    status: Type.String({ description: 'e.g. "running", "completed", "aborted".' }),
    result: Type.Optional(Type.Any({ description: 'The final answer once finished.' })),
  }, { additionalProperties: true });
  tool('worker_list', `List the workers this conversation has started, with their status and answers.
Use it to find a worker's id for worker_followup or worker_stop, or to check on workers after an interruption. Finished workers include their final answer.
Example: const workers = await tools.worker_list({})`, Type.Object({}), Type.Array(WorkerRow), (_args, api, ctx) => workerRecords(api, ctx));
  tool('worker_stop', `Stop one of this conversation's workers that is still running.
Use it when a worker is no longer needed or is taking too long. Only workers started from this conversation can be stopped; get ids from worker_list.
Example: await tools.worker_stop({ workerId: "57" })`, Type.Object({ workerId: Type.String({ description: 'Worker id from worker_list or worker_run, e.g. "57".' }) }), Type.Object({ stopped: Type.Boolean({ description: 'True when the stop was sent.' }), workerId: Type.String({ description: 'The worker stopped.' }) }), async (args, api, ctx) => {
    const child = await ownedWorker(args.workerId, api, ctx);
    await child.abort(ctx);
    return { stopped: true, workerId: args.workerId };
  });
  tool('worker_followup', `Ask one of this conversation's workers a follow-up question and wait for its answer.
Use it to refine or extend a worker's earlier answer: it remembers its own previous work. Waits until it answers. Get ids from worker_run results or worker_list.
Example: const { result } = await tools.worker_followup({ workerId: "57", task: "Now sort them by file." })`, Type.Object({
    workerId: Type.String({ description: 'Worker id from worker_run or worker_list, e.g. "57".' }),
    task: Type.String({ minLength: 1, description: 'The follow-up message for the worker.' }),
  }), Type.Object({
    id: Type.Any({ description: 'The worker id.' }),
    status: Type.String({ description: '"done" when it answered.' }),
    result: Type.String({ description: 'Its answer, up to 4000 characters.' }),
  }), async (args, api, ctx) => {
    const child = await ownedWorker(args.workerId, api, ctx);
    const settled = await (await child.submit({ type: 'input', content: args.task, whenBusy: 'followUp', requestId: `worker-followup:${api.taskId}` }, ctx)).wait(ctx);
    const answer = settled.answer ? await api.commit(tx => tx.entry(settled.answer), ctx) : undefined;
    return { id: child.id, status: settled.status, result: compact(answer?.model || []) };
  });
  return defineExtension({ name: 'mars-orchestration', tools, tasks: [workflow] });
}

export async function listWorkers({ harness, conversationId, context, limit = 100, cursor }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  const page = await harness.commit(tx => tx.scanConversations({ ownerConversationId: nativeId(conversationId), order: 'descending' }, limit, cursor), context);
  return Promise.all(page.items.map(async record => {
    const [task, agent, live, usage, label, archived] = await Promise.all([
      harness.getTask(record.owner.taskId, context),
      harness.snapshot(AgentDoc, record.id, context),
      harness.snapshot(LiveDoc, record.id, context),
      harness.snapshot(UsageDoc, record.id, context),
      harness.snapshot(nativeTitleDoc, record.id, context),
      isArchived(harness, record.id, context),
    ]);
    const receipt = receiptOf(task, record.id);
    return { id: String(record.id), conversationId: String(conversationId), childConversationId: String(record.id), title: label?.title || 'Worker', ...(label?.task ? { task: label.task } : {}), ...(label?.workflowId ? { workflowId: label.workflowId } : {}), ...(label?.taskKind ? { taskKind: label.taskKind } : {}), ...(label?.parentEntryId ? { parentEntryId: label.parentEntryId } : {}), ...agent?.model, status: live?.run ? 'running' : receipt?.status || task?.state.outcome?.status || task?.state.status || 'unknown', ...(receipt?.result ? { result: receipt.result } : {}), ...(archived ? { archived: true } : {}), usage: usage || { models: {}, tools: {} } };
  }));
}

export async function stopWorker({ harness, conversationId, workerId, context }) {
  const record = await harness.commit(tx => tx.conversation(nativeId(workerId)), context);
  if (record?.owner?.conversationId !== nativeId(conversationId)) throw Object.assign(new Error('Worker not found for conversation'), { status: 404 });
  const child = await harness.conversation(nativeId(workerId), context);
  await child.abort(context);
  return { stopped: true, workerId };
}

export async function listSubthreads(options) {
  return (await listWorkers(options)).map(({ id, conversationId, title, provider, modelId, status, parentEntryId, workflowId, archived }) => ({ id, conversationId, title, provider, modelId, status, ...(parentEntryId ? { parentEntryId } : {}), ...(workflowId ? { workflowId } : {}), ...(archived ? { archived } : {}) }));
}

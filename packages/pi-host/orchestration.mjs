import { Type } from '@earendil-works/pi-ai';
import { configure, defineExtension, defineTask, defineTool, UsageDoc, AgentDoc, LiveDoc, defineDoc } from '@earendil-works/pi-durable';

export const nativeTitleDoc = defineDoc({ kind: 'mars.conversation-title', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '' }) });
const nativeId = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const aliases = { sol: ['openai', 'gpt-6-sol'], luna: ['openai', 'gpt-6-luna'], astra: ['openai', 'gpt-6-astra'], opus: ['anthropic', 'claude-opus-4-8'] };
const compact = messages => messages.filter(m => m.role === 'assistant').at(-1)?.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 4000) || '';
const receiptOf = (task, id) => task?.state.outcome?.result?.find?.(row => row.id === id) || (task?.state.outcome?.result?.steps || task?.state.checkpoint?.steps)?.find(row => row.conversationId === String(id));
const output = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });

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
  const job = Type.Object({ title: Type.Optional(Type.String({ maxLength: 160 })), attachmentIds: Type.Optional(Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { maxItems: 4 })), task: Type.String({ minLength: 1 }), model: Type.Optional(Type.String()), provider: Type.Optional(Type.String()), modelId: Type.Optional(Type.String()) });
  const tools = [];
  function tool(name, description, parameters, execute) {
    tools.push(defineTool({ name, description, parameters, structuredOutputSchema: Type.Any(), deferred: true, replay: 'safe', executionMode: 'parallel', execute: async (args, api, ctx) => output(await execute(args, api, ctx)) }));
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
  tool('worker_run', 'Run a native task-owned selected-model worker. Aliases sol, luna, astra, opus. Use title for a concise task name. attachmentIds explicitly pass images. Returns a compact answer.', job, (args, api, ctx) => run([args], api, ctx));
  tool('worker_fanout', 'Run independent native workers concurrently and join their compact answers. Ownership and checkpoints survive restart.', Type.Object({ jobs: Type.Array(job, { minItems: 1, maxItems: maxConcurrent }) }), (args, api, ctx) => run(args.jobs, api, ctx));
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
  tool('worker_list', 'List this conversation native workers, including terminal results.', Type.Object({}), (_args, api, ctx) => workerRecords(api, ctx));
  tool('worker_stop', 'Stop a native worker owned by this conversation.', Type.Object({ workerId: Type.String() }), async (args, api, ctx) => {
    const child = await ownedWorker(args.workerId, api, ctx);
    await child.abort(ctx);
    return { stopped: true, workerId: args.workerId };
  });
  tool('worker_followup', 'Send a follow-up to a native worker owned by this conversation and await its compact answer.', Type.Object({ workerId: Type.String(), task: Type.String({ minLength: 1 }) }), async (args, api, ctx) => {
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
    const [task, agent, live, usage, label] = await Promise.all([
      harness.getTask(record.owner.taskId, context),
      harness.snapshot(AgentDoc, record.id, context),
      harness.snapshot(LiveDoc, record.id, context),
      harness.snapshot(UsageDoc, record.id, context),
      harness.snapshot(nativeTitleDoc, record.id, context),
    ]);
    const receipt = receiptOf(task, record.id);
    return { id: String(record.id), conversationId: String(conversationId), childConversationId: String(record.id), title: label?.title || 'Worker', ...(label?.task ? { task: label.task } : {}), ...(label?.workflowId ? { workflowId: label.workflowId } : {}), ...(label?.taskKind ? { taskKind: label.taskKind } : {}), ...(label?.parentEntryId ? { parentEntryId: label.parentEntryId } : {}), ...agent?.model, status: live?.run ? 'running' : receipt?.status || task?.state.outcome?.status || task?.state.status || 'unknown', ...(receipt?.result ? { result: receipt.result } : {}), usage: usage || { models: {}, tools: {} } };
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
  return (await listWorkers(options)).map(({ id, conversationId, title, provider, modelId, status, parentEntryId, workflowId }) => ({ id, conversationId, title, provider, modelId, status, ...(parentEntryId ? { parentEntryId } : {}), ...(workflowId ? { workflowId } : {}) }));
}

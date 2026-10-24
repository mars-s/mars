// Side chats (docs/WORKBENCH.md "Side chats belong to their parent"). A side chat is an
// ordinary ownerless Pi conversation plus two native documents written in the same
// commit that creates it: `mars.side-chat` on the child names its parent, and
// `mars.side-chat-index` on the parent lists its children. Pi stays the only store, so the
// UI, the HTTP API and the agent all read the same link, and a crash can never leave a
// half-linked side chat.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { LiveDoc, configure, defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { nativeTitleDoc } from './orchestration.mjs';
import { isArchived } from './organise-doc.mjs';

// A fork of a side chat is a new top-level conversation: it is not in the parent's index.
export const SideChatDoc = defineDoc({ kind: 'mars.side-chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ parentId: '' }) });
// Child ids, newest last, plus `requests`: agent request key -> child id, so a replayed
// side_chat_open finds the side chat it made even if the host stopped before the memo.
// A fork of a parent starts with no side chats of its own.
export const SideChatIndexDoc = defineDoc({ kind: 'mars.side-chat-index', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ children: [], requests: {} }) });
/**
 * `requests` lists the request ids of the messages a side chat's parent agent sent it
 * (side_chat_open with a task, or side_chat_send) that still await an answer. A final answer
 * reports to the parent only when one of those messages was already in the side chat's
 * transcript (its submission placed or done, not still queued), so the owner's own turns never
 * notify the parent and each parent message is reported once. `pending` is the older single
 * flag, still honoured for side chats flagged before this change.
 */
export const SideChatNotifyDoc = defineDoc({ kind: 'mars.side-chat-notify', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ pending: false, requests: [] }) });
/** Most outstanding parent messages remembered per side chat. */
const NOTIFY_REQUESTS_MAX = 50;
export const SIDE_CHAT_DONE = 'mars.side-chat-done';
const REPLY_EXCERPT = 4000;
const textOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : typeof message?.content === 'string' ? message.content : '').trim();

/**
 * Record, once, that the parent sent a side chat the message with this request id. A replayed
 * call whose message was already submitted records nothing, so it cannot claim a later answer.
 * Called before the submit, so a stop in between still leaves the message expected.
 */
export async function expectAnswer({ harness, sideChatId, requestId, context }) {
  const id = nativeId(String(sideChatId));
  await harness.commit(async (tx) => {
    if (await tx.submissionByRequest(id, requestId)) return;
    const flag = await tx.doc(SideChatNotifyDoc, id);
    const requests = flag.requests ?? [];
    if (!requests.includes(requestId)) flag.requests = [...requests, requestId].slice(-NOTIFY_REQUESTS_MAX);
  }, context);
}

/**
 * Which expected parent messages a final answer settles: `answered` were in the transcript
 * before this answer (placed or done), `dropped` will never be answered. Queued ones wait.
 */
export async function settledRequests({ harness, sideChatId, requests, context }) {
  const id = nativeId(String(sideChatId));
  return harness.commit(async (tx) => {
    const answered = [], dropped = [];
    for (const requestId of requests) {
      const submission = await tx.submissionByRequest(id, requestId);
      if (submission?.status === 'placed' || submission?.status === 'done') answered.push(requestId);
      else if (submission?.status === 'unanswered') dropped.push(requestId);
    }
    return { answered, dropped };
  }, context);
}

/**
 * Tell the parent that a side chat finished answering messages it sent (`requestIds`, or the
 * older `legacy` flag). The note carries the answer recorded for the first of those messages,
 * else `answer`. The model-visible entry is written first, keyed by the first answered
 * request, and only then are those requests cleared: a stop in between repeats the same keyed
 * write on the next answer instead of losing the note, and a replay never writes it twice.
 */
export async function notifyParent({ harness, sideChatId, taskId, answer, requestIds = [], dropped = [], legacy = false, context }) {
  const id = nativeId(String(sideChatId));
  const due = await harness.commit(async (tx) => {
    const flag = await tx.doc(SideChatNotifyDoc, id);
    const waiting = requestIds.filter((requestId) => (flag.requests ?? []).includes(requestId));
    if (!waiting.length && !(legacy && flag.pending)) return undefined;
    const link = await tx.doc(SideChatDoc, id);
    const label = await tx.doc(nativeTitleDoc, id);
    // A message already answered (a note that failed before) reports its own answer, not this one.
    const submission = waiting.length ? await tx.submissionByRequest(id, waiting[0]) : undefined;
    const entry = submission?.status === 'done' ? await tx.entry(submission.answer) : undefined;
    const own = textOf((entry?.model ?? []).filter((message) => message.role === 'assistant').at(-1));
    return { parentId: link.parentId, title: label.title || 'Side chat', key: waiting[0] ?? `legacy:${taskId}`, answer: own || answer };
  }, context);
  const clear = () => harness.commit(async (tx) => {
    const flag = await tx.doc(SideChatNotifyDoc, id);
    const done = new Set([...requestIds, ...dropped]);
    if ((flag.requests ?? []).some((requestId) => done.has(requestId))) flag.requests = flag.requests.filter((requestId) => !done.has(requestId));
    if (legacy && flag.pending) flag.pending = false;
  }, context);
  const parent = due?.parentId ? await harness.conversation(nativeId(due.parentId), context) : undefined;
  if (!parent) {
    await clear();
    return false;
  }
  const excerpt = due.answer.length > REPLY_EXCERPT ? due.answer.slice(0, REPLY_EXCERPT) + '…' : due.answer;
  await parent.submit({
    type: 'write',
    requestId: `side-chat-done:${sideChatId}:${due.key}`,
    entry: {
      kind: SIDE_CHAT_DONE,
      data: { sideChatId: String(sideChatId), title: due.title },
      model: [{ role: 'user', content: [{ type: 'text', text: `[Side chat "${due.title}" (id ${sideChatId}) finished. Its answer:]\n${excerpt || '(no text)'}\n[Use side_chat_read for the full answer, or side_chat_send to continue it.]` }], timestamp: Date.now() }],
    },
  }, context);
  await clear();
  return true;
}

/** Rows shown under a parent at once; older ones are counted, and paged by side_chat_list. */
export const SIDE_CHAT_PAGE = 20;
/** Hard cap per parent: beyond this, opening another is refused (prompt-injection floods). */
export const SIDE_CHAT_MAX = 200;
const nativeId = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const output = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });

/** The parent id a conversation is a side chat of, or '' for a top-level conversation. Read-only. */
export async function sideChatParent(harness, id, context) {
  return (await harness.snapshot(SideChatDoc, nativeId(id), context))?.parentId || '';
}

/**
 * Side chats of `parentId`, newest first, read from the parent's index (no scan).
 * `{ items, total }`; `offset` pages through older ones.
 */
export async function listSideChats({ harness, parentId, context, limit = SIDE_CHAT_PAGE, offset = 0 }) {
  const index = await harness.snapshot(SideChatIndexDoc, nativeId(parentId), context);
  const ids = [...(index?.children ?? [])].reverse();
  const page = ids.slice(offset, offset + limit);
  const items = await Promise.all(
    page.map(async (id) => {
      const [label, live, archived] = await Promise.all([harness.snapshot(nativeTitleDoc, nativeId(id), context), harness.snapshot(LiveDoc, nativeId(id), context), isArchived(harness, nativeId(id), context)]);
      return { id: String(id), title: label?.title || 'Side chat', running: !!live?.run, ...(archived ? { archived: true } : {}) };
    }),
  );
  return { items, total: ids.length };
}

/** Refuse a parent that is missing, a worker, or itself a side chat (one level only). Inside a commit. */
async function checkParentInTx(tx, parentId) {
  const parent = await tx.conversation(nativeId(parentId));
  if (!parent) throw fail('Parent conversation not found', 404);
  if (parent.owner) throw fail('A worker cannot have side chats');
  if ((await tx.doc(SideChatDoc, parent.id)).parentId) throw fail('A side chat cannot have its own side chats');
  return parent;
}

/**
 * Create a side chat of `parentId` in one commit: the conversation, its agent settings,
 * its title, its link to the parent and the parent's index entry. The parent is checked
 * inside the same commit, so it cannot become a side chat in between.
 * With `requestKey`, a second call with the same key returns the first side chat's id. `max`
 * raises the per-parent cap for parents that own many children by design (Duet tasks).
 * Returns `{ id }`.
 */
export async function createSideChat({ harness, parentId, agent, title, context, requestKey, max = SIDE_CHAT_MAX }) {
  const parentConversation = await harness.conversation(nativeId(parentId), context);
  if (!parentConversation) throw fail('Parent conversation not found', 404);
  return parentConversation.commit(async (tx) => {
    const parent = await checkParentInTx(tx, parentId);
    const index = await tx.doc(SideChatIndexDoc, parent.id);
    if (!index.requests) index.requests = {};
    if (requestKey && index.requests[requestKey]) return { id: index.requests[requestKey] };
    if (index.children.length >= max) throw fail(`This conversation already has ${max} side chats.`, 409);
    const child = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await configure(tx, child.id, agent);
    (await tx.doc(nativeTitleDoc, child.id)).title = (title?.trim() || 'Side chat').slice(0, 160);
    (await tx.doc(SideChatDoc, child.id)).parentId = String(parent.id);
    index.children.push(String(child.id));
    if (requestKey) index.requests[requestKey] = String(child.id);
    return { id: child.id };
  }, context);
}

/** Deferred agent tools: open, list and message the calling conversation's side chats. */
export function createSideChatExtension({ harness: getHarness, defaultAgent }) {
  const tool = (name, description, parameters, result, execute) =>
    defineTool({ name, description, parameters, structuredOutputSchema: result, deferred: true, replay: 'safe', execute: async (args, api, ctx) => output(await execute(args, api, ctx)) });

  async function ownSideChat(api, id, ctx) {
    const record = await api.commit((tx) => tx.conversation(nativeId(id)), ctx);
    if (!record || record.owner) throw fail('That side chat does not belong to this conversation', 404);
    const link = await getHarness().snapshot(SideChatDoc, record.id, ctx);
    if (String(link?.parentId) !== String(api.conversationId)) throw fail('That side chat does not belong to this conversation', 404);
    return api.conversation(nativeId(id), ctx);
  }

  const SideChatRow = Type.Object({
    id: Type.String({ description: 'Side chat id. Pass it to side_chat_send as sideChatId.' }),
    title: Type.String({ description: 'Title shown in the sidebar.' }),
    running: Type.Boolean({ description: 'True while the side chat is still answering.' }),
  });
  return defineExtension({
    name: 'mars-side-chats',
    tools: [
      tool(
        'side_chat_open',
        `Open a side chat nested under this conversation, optionally starting it on a task.
Use it for work the owner should be able to open and follow on its own: research, a draft, a long investigation. It runs on its own and returns at once with its id; it does not wait for an answer. To get an answer back into this conversation, use worker_run instead. Calling it again after an interruption reuses the same side chat. At most ${SIDE_CHAT_MAX} per conversation; a side chat cannot open side chats of its own.
Example: await tools.side_chat_open({ title: "Release names", task: "Suggest three names for the workbench release." })`,
        Type.Object({
          title: Type.Optional(Type.String({ maxLength: 160, description: 'Short name shown in the sidebar, e.g. "Release names". Default "Side chat".' })),
          task: Type.Optional(Type.String({ minLength: 1, maxLength: 100000, description: 'First message to send to the side chat. Omit to open it empty for the owner.' })),
        }),
        Type.Object({
          id: Type.String({ description: 'The new side chat id. Pass it to side_chat_send.' }),
          title: Type.String({ description: 'Title shown in the sidebar.' }),
          parentId: Type.String({ description: 'This conversation id.' }),
        }),
        async (args, api, ctx) => {
          const title = (args.title?.trim() || 'Side chat').slice(0, 160);
          // A replayed call reuses the side chat it already created. Creation is one commit
          // that also records this call's key in the parent's index, so even a stop between
          // that commit and the memo finds the same side chat instead of making a second.
          let id = await api.memo('side-chat', ctx);
          if (id === undefined) {
            const agent = await api.agent(ctx);
            const requestKey = `${api.taskId}:${api.callId}`;
            const child = await createSideChat({ harness: getHarness(), parentId: String(api.conversationId), agent: { ...defaultAgent, model: agent.model }, title, context: ctx, requestKey });
            id = await api.memo('side-chat', String(child.id), ctx);
          }
          if (args.task) {
            const child = await api.conversation(nativeId(id), ctx);
            const requestId = `side-chat-open:${api.taskId}:${api.callId}`;
            await expectAnswer({ harness: getHarness(), sideChatId: id, requestId, context: ctx });
            await child.submit({ type: 'input', content: args.task, requestId }, ctx);
          }
          return { id, title, parentId: String(api.conversationId) };
        },
      ),
      tool(
        'side_chat_list',
        `List the side chats opened from this conversation, newest first.
Use it to find a side chat's id for side_chat_send, or to see which ones are still running. Returns ${SIDE_CHAT_PAGE} at a time with the total; pass offset to page back through older ones. Only this conversation's own side chats are listed.
Example: const { items, total } = await tools.side_chat_list({})`,
        Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, maximum: SIDE_CHAT_MAX, default: 0, description: `How many of the newest to skip, for paging, e.g. ${SIDE_CHAT_PAGE} for the second page.` })) }),
        Type.Object({
          items: Type.Array(SideChatRow, { description: `Up to ${SIDE_CHAT_PAGE} side chats, newest first.` }),
          total: Type.Integer({ description: 'How many side chats this conversation has in all.' }),
        }),
        (args, api, ctx) => listSideChats({ harness: getHarness(), parentId: String(api.conversationId), context: ctx, offset: args.offset ?? 0 }),
      ),
      tool(
        'side_chat_send',
        `Send a message to one of this conversation's side chats.
Use it to give a side chat more instructions. It returns at once; the side chat answers on its own and the reply appears there, not here. If the side chat is busy, the message waits its turn. Only side chats opened from this conversation can be messaged; get ids from side_chat_list.
Example: await tools.side_chat_send({ sideChatId: "42", text: "Make them shorter." })`,
        Type.Object({
          sideChatId: Type.String({ pattern: '^[0-9]+$', description: 'Id of the side chat, from side_chat_open or side_chat_list, e.g. "42".' }),
          text: Type.String({ minLength: 1, maxLength: 100000, description: 'The message to send, as plain text.' }),
        }),
        Type.Object({
          sent: Type.Boolean({ description: 'Always true when the call returns; failures throw.' }),
          sideChatId: Type.String({ description: 'The side chat the message went to.' }),
          submissionId: Type.String({ description: 'Id of the queued message.' }),
        }),
        async (args, api, ctx) => {
          const child = await ownSideChat(api, args.sideChatId, ctx);
          const requestId = `side-chat-send:${api.taskId}:${api.callId}`;
          await expectAnswer({ harness: getHarness(), sideChatId: child.id, requestId, context: ctx });
          const submission = await child.submit({ type: 'input', content: args.text, whenBusy: 'followUp', requestId }, ctx);
          return { sent: true, sideChatId: args.sideChatId, submissionId: String(submission.id) };
        },
      ),
      tool(
        'side_chat_read',
        `Read a side chat's latest answer and whether it is still working.
Use it after a "[Side chat ... finished]" note, or to check on a side chat you gave work to. It returns the newest answer (up to 20000 characters) and running; it does not wait. Only this conversation's side chats can be read.
Example: await tools.side_chat_read({ sideChatId: "42" })`,
        Type.Object({
          sideChatId: Type.String({ minLength: 1, maxLength: 20, description: 'Side chat id from side_chat_open or side_chat_list, e.g. "42".' }),
        }),
        Type.Object({
          sideChatId: Type.String({ description: 'The side chat id.' }),
          title: Type.String({ description: 'Title shown in the sidebar.' }),
          running: Type.Boolean({ description: 'True while it is still answering.' }),
          answer: Type.String({ description: 'Its newest answer text, or "" if it has not answered yet.' }),
          truncated: Type.Boolean({ description: 'True when the answer was cut at 20000 characters.' }),
        }),
        async (args, api, ctx) => {
          const child = await ownSideChat(api, args.sideChatId, ctx);
          const [label, live] = await Promise.all([getHarness().snapshot(nativeTitleDoc, child.id, ctx), getHarness().snapshot(LiveDoc, child.id, ctx)]);
          const view = await (await getHarness().conversation(child.id, ctx)).viewState(ctx);
          let answer = '';
          try {
            const messages = view.value.entries.flatMap((entry) => entry.model ?? []);
            for (let i = messages.length - 1; i >= 0 && !answer; i--) if (messages[i].role === 'assistant') answer = textOf(messages[i]);
          } finally {
            view.dispose();
          }
          return { sideChatId: String(args.sideChatId), title: label?.title || 'Side chat', running: !!live?.run, answer: answer.slice(0, 20000), truncated: answer.length > 20000 };
        },
      ),
    ],
    hooks: [{
      task: 'pi.generation',
      handlers: {
        // A final answer (no tool calls) from a side chat with work from its parent. Which parent
        // messages it answers is read now: this runs before the run takes its next queued message,
        // so a parent message still queued behind the owner's turn is not claimed by the owner's
        // answer. The parent is notified after this commit, never delaying the side chat itself.
        afterResponse: async (message, api, ctx) => {
          if (message.stopReason !== 'stop') return;
          const flag = await api.snapshot(SideChatNotifyDoc, api.conversationId, ctx);
          const legacy = !!flag?.pending;
          if (!legacy && !flag?.requests?.length) return;
          const sideChatId = String(api.conversationId);
          const { answered, dropped } = flag.requests?.length ? await settledRequests({ harness: getHarness(), sideChatId, requests: flag.requests, context: ctx }) : { answered: [], dropped: [] };
          if (!legacy && !answered.length && !dropped.length) return;
          const taskId = String(api.taskId);
          const answer = textOf(message);
          setImmediate(() => { notifyParent({ harness: getHarness(), sideChatId, taskId, answer, requestIds: answered, dropped, legacy, context: BACKGROUND_CONTEXT }).catch(() => {}); });
        },
      },
    }],
  });
}
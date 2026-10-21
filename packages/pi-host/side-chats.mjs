// Side chats (docs/WORKBENCH.md "Side chats belong to their parent"). A side chat is an
// ordinary ownerless Pi conversation plus a native document naming its parent, so Pi
// stays the only store and the UI, the HTTP API and the agent all read the same link.
import { Type } from '@earendil-works/pi-ai';
import { AgentDoc, LiveDoc, defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { nativeTitleDoc } from './orchestration.mjs';

export const SideChatDoc = defineDoc({ kind: 'mars.side-chat', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ parentId: '' }) });
export const SIDE_CHAT_LIMIT = 20;
const nativeId = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const output = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });

/** The parent id a conversation is a side chat of, or '' for a top-level conversation. */
export async function sideChatParent(harness, id, context) {
  return (await harness.snapshot(SideChatDoc, nativeId(id), context))?.parentId || '';
}

/**
 * Side chats of `parentId`, newest first. Scans recent ownerless conversations; a side
 * chat is always newer than its parent, so the scan stops once it passes the parent.
 */
export async function listSideChats({ harness, parentId, context, limit = SIDE_CHAT_LIMIT }) {
  const parent = nativeId(parentId);
  const rows = [];
  let cursor;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100, cursor), context);
    for (const record of page.items) {
      if (record.owner) continue;
      if (record.id === parent) return finish();
      const link = await harness.snapshot(SideChatDoc, record.id, context);
      if (String(link?.parentId) === String(parentId)) rows.push(record.id);
      if (rows.length >= limit) return finish();
    }
    cursor = page.next;
  } while (cursor);
  return finish();
  async function finish() {
    return Promise.all(
      rows.map(async (id) => {
        const [label, live] = await Promise.all([harness.snapshot(nativeTitleDoc, id, context), harness.snapshot(LiveDoc, id, context)]);
        return { id: String(id), title: label?.title || 'Side chat', running: !!live?.run };
      }),
    );
  }
}

/** Refuse a parent that is missing, a worker, or itself a side chat (one level only). */
export async function checkSideChatParent({ harness, parentId, context }) {
  const parentRecord = await harness.commit((tx) => tx.conversation(nativeId(parentId)), context);
  if (!parentRecord) throw fail('Parent conversation not found', 404);
  if (parentRecord.owner) throw fail('A worker cannot have side chats');
  if (await sideChatParent(harness, parentId, context)) throw fail('A side chat cannot have its own side chats');
  return parentRecord;
}

/** Mark `childId` as a side chat of `parentId`. */
export async function linkSideChat({ harness, childId, parentId, context }) {
  const parentRecord = await checkSideChatParent({ harness, parentId, context });
  const child = await harness.conversation(nativeId(childId), context);
  await child.commit(async (tx) => {
    (await tx.doc(SideChatDoc, child.id)).parentId = String(parentRecord.id);
  }, context);
}

/** Deferred agent tools: open, list and message the calling conversation's side chats. */
export function createSideChatExtension({ createConversation, harness: getHarness }) {
  const tool = (name, description, parameters, execute) =>
    defineTool({ name, description, parameters, structuredOutputSchema: Type.Any(), deferred: true, replay: 'safe', execute: async (args, api, ctx) => output(await execute(args, api, ctx)) });

  async function ownSideChat(api, id, ctx) {
    const record = await api.commit((tx) => tx.conversation(nativeId(id)), ctx);
    if (!record || record.owner) throw fail('That side chat does not belong to this conversation', 404);
    const link = await getHarness().snapshot(SideChatDoc, record.id, ctx);
    if (String(link?.parentId) !== String(api.conversationId)) throw fail('That side chat does not belong to this conversation', 404);
    return api.conversation(nativeId(id), ctx);
  }

  return defineExtension({
    name: 'mars-side-chats',
    tools: [
      tool(
        'side_chat_open',
        'Open a side chat beside this conversation (it shows nested under this chat in the sidebar). Optionally send `task` as its first message. Returns at once with { id, title }; it does not wait for an answer. Use side_chat_list to check on it.',
        Type.Object({ title: Type.Optional(Type.String({ maxLength: 160 })), task: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })) }),
        async (args, api, ctx) => {
          // A replayed call reuses the side chat it already created.
          const id = (await api.memo('side-chat', ctx)) ?? (await api.memo('side-chat', String((await createConversation({ title: args.title || 'Side chat', parentId: String(api.conversationId) })).id), ctx));
          if (args.task) {
            const child = await api.conversation(nativeId(id), ctx);
            await child.submit({ type: 'input', content: args.task, requestId: `side-chat-open:${api.taskId}:${api.callId}` }, ctx);
          }
          return { id, title: args.title || 'Side chat', parentId: String(api.conversationId) };
        },
      ),
      tool('side_chat_list', "List this conversation's side chats, newest first, with whether each is running.", Type.Object({}), (_args, api, ctx) =>
        listSideChats({ harness: getHarness(), parentId: String(api.conversationId), context: ctx }),
      ),
      tool(
        'side_chat_send',
        "Send a message to one of this conversation's own side chats. Returns at once; the reply appears in that side chat.",
        Type.Object({ sideChatId: Type.String({ pattern: '^[0-9]+$' }), text: Type.String({ minLength: 1, maxLength: 100000 }) }),
        async (args, api, ctx) => {
          const child = await ownSideChat(api, args.sideChatId, ctx);
          const submission = await child.submit({ type: 'input', content: args.text, whenBusy: 'followUp', requestId: `side-chat-send:${api.taskId}:${api.callId}` }, ctx);
          return { sent: true, sideChatId: args.sideChatId, submissionId: String(submission.id) };
        },
      ),
    ],
  });
}

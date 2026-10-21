// Side chats (docs/WORKBENCH.md "Side chats belong to their parent"). A side chat is an
// ordinary ownerless Pi conversation plus two native documents written in the same
// commit that creates it: `mars.side-chat` on the child names its parent, and
// `mars.side-chat-index` on the parent lists its children. Pi stays the only store, so the
// UI, the HTTP API and the agent all read the same link, and a crash can never leave a
// half-linked side chat.
import { Type } from '@earendil-works/pi-ai';
import { LiveDoc, configure, defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { nativeTitleDoc } from './orchestration.mjs';

// A fork of a side chat is a new top-level conversation: it is not in the parent's index.
export const SideChatDoc = defineDoc({ kind: 'mars.side-chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ parentId: '' }) });
// Child ids, newest last. A fork of a parent starts with no side chats of its own.
export const SideChatIndexDoc = defineDoc({ kind: 'mars.side-chat-index', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ children: [] }) });
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
      const [label, live] = await Promise.all([harness.snapshot(nativeTitleDoc, nativeId(id), context), harness.snapshot(LiveDoc, nativeId(id), context)]);
      return { id: String(id), title: label?.title || 'Side chat', running: !!live?.run };
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
 */
export async function createSideChat({ harness, parentId, agent, title, context }) {
  const parentConversation = await harness.conversation(nativeId(parentId), context);
  if (!parentConversation) throw fail('Parent conversation not found', 404);
  return parentConversation.commit(async (tx) => {
    const parent = await checkParentInTx(tx, parentId);
    const index = await tx.doc(SideChatIndexDoc, parent.id);
    if (index.children.length >= SIDE_CHAT_MAX) throw fail(`This conversation already has ${SIDE_CHAT_MAX} side chats.`, 409);
    const child = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await configure(tx, child.id, agent);
    (await tx.doc(nativeTitleDoc, child.id)).title = (title?.trim() || 'Side chat').slice(0, 160);
    (await tx.doc(SideChatDoc, child.id)).parentId = String(parent.id);
    index.children.push(String(child.id));
    return child;
  }, context);
}

/** Deferred agent tools: open, list and message the calling conversation's side chats. */
export function createSideChatExtension({ harness: getHarness, defaultAgent }) {
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
        `Open a side chat beside this conversation (it shows nested under this chat in the sidebar). Optionally send \`task\` as its first message. Returns at once with { id, title }; it does not wait for an answer. Use side_chat_list to check on it. At most ${SIDE_CHAT_MAX} side chats per conversation.`,
        Type.Object({ title: Type.Optional(Type.String({ maxLength: 160 })), task: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })) }),
        async (args, api, ctx) => {
          const title = (args.title?.trim() || 'Side chat').slice(0, 160);
          // A replayed call reuses the side chat it already created: creation is one commit,
          // and its id is memoised before anything else can happen.
          let id = await api.memo('side-chat', ctx);
          if (id === undefined) {
            const agent = await api.agent(ctx);
            const child = await createSideChat({ harness: getHarness(), parentId: String(api.conversationId), agent: { ...defaultAgent, model: agent.model }, title, context: ctx });
            id = await api.memo('side-chat', String(child.id), ctx);
          }
          if (args.task) {
            const child = await api.conversation(nativeId(id), ctx);
            await child.submit({ type: 'input', content: args.task, requestId: `side-chat-open:${api.taskId}:${api.callId}` }, ctx);
          }
          return { id, title, parentId: String(api.conversationId) };
        },
      ),
      tool(
        'side_chat_list',
        `List this conversation's side chats, newest first: { items: [{ id, title, running }], total }. Pages of ${SIDE_CHAT_PAGE}; pass offset for older ones.`,
        Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, maximum: SIDE_CHAT_MAX })) }),
        (args, api, ctx) => listSideChats({ harness: getHarness(), parentId: String(api.conversationId), context: ctx, offset: args.offset ?? 0 }),
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

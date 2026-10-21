import { listSubthreads, nativeTitleDoc } from './orchestration.mjs';
import { SIDE_CHAT_PAGE, createSideChat, listSideChats, sideChatParent } from './side-chats.mjs';
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable';

export const TitleDoc = nativeTitleDoc;
const nativeId = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
/** Native conversation handles remain the only conversation store. */
export function createConversationManager({ harness, root, context, defaultAgent }) {
  async function resolve(id = root.id) {
    const conversation = await harness.conversation(nativeId(id || root.id), context);
    if (!conversation) throw Object.assign(new Error('Conversation not found'), { status: 404 });
    const record = await harness.commit(tx => tx.conversation(conversation.id), context);
    await validateOwnership(record);
    return conversation;
  }
  async function validateOwnership(record) {
    const seen = new Set();
    while (record?.owner) {
      if (seen.has(record.id)) throw new Error('Invalid conversation ownership cycle');
      seen.add(record.id);
      const owner = await harness.getTask(record.owner.taskId, context);
      if (!owner || owner.conversationId !== record.owner.conversationId) throw Object.assign(new Error('Invalid conversation owner'), { status: 404 });
      record = await harness.commit(tx => tx.conversation(record.owner.conversationId), context);
      if (!record) throw Object.assign(new Error('Conversation parent not found'), { status: 404 });
    }
  }
  async function stateOf(conversation) {
    const view = await conversation.viewState(context);
    try { return structuredClone(view.value); } finally { view.dispose(); }
  }
  async function title(conversation, value) {
    if (value?.trim()) await conversation.commit(async tx => {
      (await tx.doc(TitleDoc, conversation.id)).title = value.trim().slice(0, 160);
    }, context);
  }
  async function row(record) {
    const [label, agent, live] = await Promise.all([
      harness.snapshot(TitleDoc, record.id, context),
      harness.snapshot(AgentDoc, record.id, context),
      harness.snapshot(LiveDoc, record.id, context),
    ]);
    return { id: String(record.id), title: label?.title || (record.id === root.id ? 'Main conversation' : 'New conversation'), ...agent?.model, running: !!live?.run };
  }
  /** A top-level row with its newest side chats nested inside it, and how many there are. */
  async function topRow(record) {
    const { items, total } = await listSideChats({ harness, parentId: String(record.id), context });
    return { ...(await row(record)), sideChats: items, ...(total > SIDE_CHAT_PAGE ? { sideChatTotal: total } : {}) };
  }
  async function listPage({ limit = 100, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
    // Native scans include owned children and side chats, so fill the page across batches.
    // Reads only: the side-chat link is read with snapshot, which never creates a document.
    const items = [];
    let next = cursor;
    do {
      const batch = await harness.commit(tx => tx.scanConversations({ order: 'descending' }, limit - items.length, next), context);
      for (const record of batch.items)
        if (!record.owner && !(await sideChatParent(harness, record.id, context))) items.push(record);
      next = batch.next;
    } while (next && items.length < limit);
    const page = { items, next };
    return { items: await Promise.all(page.items.map(topRow)), next: page.next };
  }
  return {
    resolve,
    async selectedThread(id) {
      const conversation = await resolve(id);
      const record = await harness.commit(tx => tx.conversation(conversation.id), context);
      const label = await harness.snapshot(TitleDoc, conversation.id, context);
      const sideChatOf = record.owner ? '' : await sideChatParent(harness, conversation.id, context);
      return {
        conversationTitle: label?.title || (record.owner ? 'Worker' : sideChatOf ? 'Side chat' : 'New conversation'),
        ...(record.owner ? { parentConversationId: String(record.owner.conversationId) } : {}),
        ...(sideChatOf ? { parentConversationId: sideChatOf, sideChatOf } : {}),
      };
    },
    async listSubthreads({ conversationId = root.id, limit = 100 } = {}) {
      await resolve(conversationId);
      return listSubthreads({ harness, conversationId, context, limit });
    },
    async state(id) { return stateOf(await resolve(id)); },
    listPage,
    async list(options) {
      const { items } = await listPage(options);
      if (!items.some(item => item.id === String(root.id))) {
        if (items.length === 100) items.pop();
        items.push(await topRow({ id: root.id }));
      }
      return items;
    },
    async create(options = {}) {
      const agent = { ...defaultAgent };
      if (options.modelId || options.provider) {
        if (!options.modelId || !options.provider) throw new Error('provider and modelId are required together');
        agent.model = { provider: options.provider, modelId: options.modelId };
      }
      if (options.thinking) agent.thinkingLevel = options.thinking;
      if (options.parentId !== undefined) {
        if (!/^\d+$/.test(String(options.parentId))) throw Object.assign(new Error('parentId must be a conversation id'), { status: 400 });
        // One commit: conversation, settings, title, link and the parent's index entry.
        const record = await createSideChat({ harness, parentId: String(options.parentId), agent, title: options.title, context });
        return harness.conversation(record.id, context);
      }
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context);
      await title(conversation, options.title);
      return conversation;
    },
    async fork({ conversationId, entryId, title: label }) {
      const source = await resolve(conversationId);
      const conversation = await source.fork(nativeId(entryId), { ownership: { kind: 'ownerless' } }, context);
      await title(conversation, label);
      return conversation;
    },
  };
}

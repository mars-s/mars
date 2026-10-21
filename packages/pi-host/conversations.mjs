import { listSubthreads, nativeTitleDoc } from './orchestration.mjs';
import { SIDE_CHAT_PAGE, createSideChat, listSideChats, sideChatParent } from './side-chats.mjs';
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable';
import { OrganiseDoc } from './organise-doc.mjs';

export const TitleDoc = nativeTitleDoc;
export { OrganiseDoc };
export const GROUP_MAX = 60;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
/** One line of plain text, trimmed and cut to `max` characters. */
const oneLine = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max);
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
    const [label, agent, live, filed] = await Promise.all([
      harness.snapshot(TitleDoc, record.id, context),
      harness.snapshot(AgentDoc, record.id, context),
      harness.snapshot(LiveDoc, record.id, context),
      harness.snapshot(OrganiseDoc, record.id, context),
    ]);
    return {
      id: String(record.id),
      title: label?.title || (record.id === root.id ? 'Main conversation' : 'New conversation'),
      ...agent?.model,
      running: !!live?.run,
      group: filed?.group || '',
      archived: filed?.archived === true,
    };
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
    /**
     * File a conversation: rename it, move a top-level chat to a group ('' for none), or archive
     * any chat, side chat or sub-thread. Only the fields given change.
     */
    async organise({ conversationId, title: label, group, archived } = {}) {
      if (!/^\d+$/.test(String(conversationId ?? ''))) throw fail('conversationId must be a conversation id');
      const conversation = await resolve(String(conversationId));
      const record = await harness.commit(tx => tx.conversation(conversation.id), context);
      const nested = record.owner ? 'A sub-thread' : (await sideChatParent(harness, conversation.id, context)) ? 'A side chat' : '';
      if (nested && group !== undefined) throw fail(`${nested} stays under its parent; only top-level chats go in groups`);
      if (label !== undefined && (typeof label !== 'string' || !oneLine(label, 160))) throw fail('title must be non-empty text');
      if (group !== undefined && typeof group !== 'string') throw fail('group must be text');
      if (group !== undefined && group.trim().length > GROUP_MAX) throw fail(`group must be at most ${GROUP_MAX} characters`);
      if (archived !== undefined && typeof archived !== 'boolean') throw fail('archived must be true or false');
      if (label === undefined && group === undefined && archived === undefined) throw fail('Nothing to change: give title, group or archived');
      await conversation.commit(async tx => {
        if (label !== undefined) {
          // The owner's own name: the background model never replaces it.
          const doc = await tx.doc(TitleDoc, conversation.id);
          doc.title = oneLine(label, 160);
          doc.auto = false;
        }
        if (group !== undefined || archived !== undefined) {
          const filed = await tx.doc(OrganiseDoc, conversation.id);
          if (group !== undefined) filed.group = oneLine(group, GROUP_MAX);
          if (archived !== undefined) filed.archived = archived;
        }
      }, context);
      return row(record);
    },
    /** Name an untitled top-level conversation after its first message. Never renames. */
    async autoTitle(conversation, text) {
      if (conversation.id === root.id || typeof text !== 'string') return;
      const words = oneLine(text, 200);
      if (!words) return;
      const label = words.length > 60 ? words.slice(0, 60).replace(/\s+\S*$/, '') + '…' : words;
      const record = await harness.commit(tx => tx.conversation(conversation.id), context);
      if (record.owner || (await harness.snapshot(TitleDoc, conversation.id, context))?.title) return;
      await conversation.commit(async tx => {
        const doc = await tx.doc(TitleDoc, conversation.id);
        if (!doc.title) {
          doc.title = label;
          // An automatic name: the background model may improve it once (model-settings.mjs).
          doc.auto = true;
        }
      }, context);
    },
    async fork({ conversationId, entryId, title: label }) {
      const source = await resolve(conversationId);
      const conversation = await source.fork(nativeId(entryId), { ownership: { kind: 'ownerless' } }, context);
      await title(conversation, label);
      return conversation;
    },
  };
}

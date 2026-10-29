// The sidebar's one Archived list (docs/LIVE-INTEGRATION.md "Archive"): archived chats, and side
// chats and sub-threads that are archived or have finished, newest activity first. Finished side
// sessions archive themselves: they leave their parent's list and land on top of this one.
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable';
import { nativeTitleDoc } from './orchestration.mjs';
import { OrganiseDoc } from './organise-doc.mjs';
import { sideChatParent } from './side-chats.mjs';

/** Raw worker task states that mean the work is still going. */
const ACTIVE = new Set(['running', 'started', 'pending', 'scheduled', 'stopping', 'waiting']);

/**
 * createArchive({ harness, context, hidden }).list({ offset, limit }) → { items, total }.
 * hidden(id) marks conversations of another kind (the Duet thread); their children are skipped.
 */
export function createArchive({ harness, context, hidden = async () => false, rootId = () => '' }) {
  const titleOf = async (id, fallback) => (await harness.snapshot(nativeTitleDoc, id, context))?.title || fallback;
  async function lastEntry(id) {
    try {
      const conversation = await harness.conversation(id, context);
      const page = await conversation.entries({ order: 'descending' }, 1, undefined, context);
      return Number(page.items[0]?.id ?? id);
    } catch {
      return Number(id);
    }
  }
  /** The archive row for one conversation record, or null when it is not archived or finished. */
  async function rowOf(record) {
    const id = record.id;
    const [label, live, filed] = await Promise.all([
      harness.snapshot(nativeTitleDoc, id, context),
      harness.snapshot(LiveDoc, id, context),
      harness.snapshot(OrganiseDoc, id, context),
    ]);
    const archived = filed?.archived === true;
    const running = !!live?.run;
    if (record.owner) {
      const parentId = record.owner.conversationId;
      const parent = await harness.commit((tx) => tx.conversation(parentId), context);
      // Only a top-level chat's own sub-threads; workflow steps and nested workers are not listed.
      if (!parent || parent.owner || label?.workflowId) return null;
      const side = await sideChatParent(harness, parentId, context);
      if ((await hidden(String(parentId))) || (side && (await hidden(side)))) return null;
      const task = await harness.getTask(record.owner.taskId, context);
      const status = running ? 'running' : String(task?.state?.outcome?.status || task?.state?.status || 'unknown');
      if (!archived && (running || ACTIVE.has(status))) return null;
      return { id: String(id), title: label?.title || 'Sub-thread', kind: 'task', parentId: String(parentId), parentTitle: await titleOf(parentId, 'Chat'), status, archived };
    }
    const side = await sideChatParent(harness, id, context);
    if (side) {
      if (await hidden(side)) return null;
      // A running side chat stays under its parent, even one archived earlier.
      if (running) return null;
      return { id: String(id), title: label?.title || 'Side chat', kind: 'side', parentId: side, parentTitle: await titleOf(Number(side), 'Chat'), status: 'done', archived };
    }
    if (!archived || (await hidden(String(id)))) return null;
    const agent = await harness.snapshot(AgentDoc, id, context);
    return { id: String(id), title: label?.title || (String(id) === String(rootId()) ? 'Main conversation' : 'New conversation'), kind: 'chat', status: running ? 'running' : 'done', archived, ...(agent?.model ?? {}) };
  }
  async function list({ offset = 0, limit = 50 } = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be 0 or more'), { status: 400 });
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('limit must be 1..100'), { status: 400 });
    const rows = [];
    for (let next, first = true; first || next; first = false) {
      const batch = await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 100, next), context);
      const found = await Promise.all(batch.items.map(async (record) => {
        const row = await rowOf(record);
        return row && { ...row, at: await lastEntry(record.id) };
      }));
      rows.push(...found.filter(Boolean));
      next = batch.next;
    }
    // Newest activity first: whatever finished last sits on top.
    rows.sort((a, b) => b.at - a.at);
    return { items: rows.slice(offset, offset + limit).map(({ at: _at, ...row }) => row), total: rows.length };
  }
  return { list };
}

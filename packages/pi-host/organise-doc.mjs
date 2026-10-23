// How the owner files a conversation (docs: apps/ui/docs/FULL-CONTROL.md): an optional group
// name and a pinned flag for a top-level chat, and an archived flag for any chat, side chat or sub-thread. Native,
// per conversation, so Pi stays the only store. A fork starts unfiled. Kept in its own module so
// conversations, side chats and orchestration can all read it without importing each other.
import { defineDoc } from '@earendil-works/pi-durable';

export const OrganiseDoc = defineDoc({ kind: 'mars.conversation-organise', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ group: '', archived: false, pinned: false }) });

/** Whether a conversation is archived. Read-only: never creates the document. */
export async function isArchived(harness, id, context) {
  return (await harness.snapshot(OrganiseDoc, id, context))?.archived === true;
}

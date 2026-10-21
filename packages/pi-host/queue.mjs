// Queued messages (docs: apps/ui/docs/FULL-CONTROL.md "Queue and steer"). Pi's own inbox is the
// queue: a message sent while a reply runs is a followUp submission that waits for the run to
// finish. Steering turns a queued followUp into a steer submission, which Pi places at the next
// tool boundary of the current run. Nothing here keeps its own copy of the queue.
import { InboxDoc } from '@earendil-works/pi-durable';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const nativeId = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);

/** How a new message waits when a reply is running. Queue is the default. */
export function whenBusy(mode) {
  if (mode === undefined || mode === 'queue') return 'followUp';
  if (mode === 'steer') return 'steer';
  throw fail('mode must be "queue" or "steer"');
}

async function queued(harness, conversation, submissionId, context) {
  if (!/^\d+$/.test(String(submissionId ?? ''))) throw fail('submissionId must be a queued message id');
  const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
  const item = inbox?.items?.find((row) => String(row.id) === String(submissionId));
  if (!item || item.mode === 'write') throw fail('That message is no longer queued', 404);
  return item;
}

/**
 * Send a queued message into the running reply now. Pi withdraws the followUp and the same
 * content and entry are resubmitted as a steer. If the run already took the message, nothing
 * changes and `placed` is true.
 */
export async function steerQueued({ harness, conversation, submissionId, context }) {
  const item = await queued(harness, conversation, submissionId, context);
  if (item.mode === 'steer') return { steered: true, submissionId: String(item.id) };
  const withdrawn = await harness.abortSubmission(nativeId(String(item.id)), context, conversation.id);
  if (withdrawn !== 'aborted') return { steered: false, placed: true };
  const submission = await conversation.submit(
    { type: 'input', content: item.content, ...(item.entry ? { entry: item.entry } : {}), whenBusy: 'steer', requestId: `steer:${item.id}` },
    context,
  );
  return { steered: true, submissionId: String(submission.id) };
}

/**
 * Stop the running reply but keep the owner's queued messages. Pi's abort withdraws queued
 * input, so they are read first and resubmitted in order afterwards: the first starts the next
 * reply and the rest wait behind it, as they would have.
 */
export async function abortKeepingQueue({ harness, conversation, context, background = false }) {
  const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
  const kept = (inbox?.items ?? []).filter((item) => item.mode !== 'write');
  await conversation.abort(context, { background });
  for (const item of kept)
    await conversation.submit(
      { type: 'input', content: item.content, ...(item.entry ? { entry: item.entry } : {}), whenBusy: 'followUp', requestId: `kept:${item.id}` },
      context,
    );
  return { aborted: true, kept: kept.length };
}

/** Withdraw a queued message before it is sent. */
export async function removeQueued({ harness, conversation, submissionId, context }) {
  const item = await queued(harness, conversation, submissionId, context);
  const result = await harness.abortSubmission(nativeId(String(item.id)), context, conversation.id);
  return { removed: result === 'aborted', ...(result === 'aborted' ? {} : { placed: true }) };
}

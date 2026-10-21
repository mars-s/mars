# Pi Durable features the gateway reuses

Research date: 22 October 2026. Source: the installed package
`node_modules/@earendil-works/pi-durable` version 1.3.0 (README and `dist/*.d.ts`), read
directly. Line references are to that install. Purpose: build the gateway on Pi instead of
adding a second store (the repo rule in docs/ARCHITECTURE.md).

## What Pi already gives

| Need | Pi feature | Where |
| --- | --- | --- |
| Durable sessions | Conversations in one SQLite store; `harness.conversation(id)`, `createConversation({ ownership: { kind: "ownerless" } })` | README "Concepts", "More Conversations and Forks" |
| Redelivery safety | `submit({ requestId })` returns the existing submission for a repeated id, also after a restart | README "Persist and Resume"; `dist/harness/submissions.js` line 129 looks it up with `tx.submissionByRequest(conversationId, requestId)` |
| Request id scope | **Per conversation**: `SubmissionRecordBase.requestId` is documented as "Host-provided deduplication key, scoped to the conversation" | `dist/types.d.ts` lines 329 to 334 |
| Busy behaviour | `whenBusy: "followUp"` (default) queues after the current answer, `"steer"` joins it after the current tool round, `"reject"` throws `ConversationBusy` | README "Busy Conversations" |
| Queue inspection | `InboxDoc` items carry `mode: "steer" \| "followUp" \| "write"` | `dist/harness/inbox.d.ts` |
| Waiting for an answer | `submission.wait()` settles `done` with `answer` (entry id) or `unanswered` with `reason`; `harness.submission(id)` reacquires one after a restart | `dist/harness/types.d.ts` (Submission), `dist/types.d.ts` line 336 on |
| Custom entry kind for an input | `submit({ type: "input", content, entry: { kind, data } })` keeps the model input as `content` and shows the entry kind in the transcript | README "Busy Conversations" |
| Gateway state | `defineDoc({ scope: "session" })` singleton documents, edited in `harness.commit((tx) => tx.doc(Token))`, read with `harness.snapshot(Token)` | `dist/documents.d.ts`; `dist/types.d.ts` `Session.snapshot` |
| Per-conversation tag | `defineDoc({ scope: "conversation", history: "latest", fork: "initial" })` | `dist/types.d.ts` lines 31 to 51 |
| Running state | `LiveDoc.run` while answering | `dist/harness/live.d.ts` |
| Stop | `conversation.abort()` | README "Abort and Subagents" |

## Consequences for the design

1. The gateway's admission key is the Pi `requestId`. Because it is scoped per
   conversation, a redelivery after `/new` rebinds the chat would reach a different
   conversation, so the gateway also keeps recent event keys in its own session document.
2. A steer and a queued follow-up can be answered by one run, so several submissions can
   settle with the same `answer` entry. The gateway records which answer entries it has
   delivered per chat and sends each once (found by `check-gateway.mjs` section 5b).
3. No second scheduler: delivery retries and the outbox are a session document, driven by
   the host process; Pi tasks are not needed for them.
4. Not used: `watchEvents` (experimental) for streaming. v1 sends final answers plus a
   typing indicator, matching research decision 12 in gateway-designs.md.

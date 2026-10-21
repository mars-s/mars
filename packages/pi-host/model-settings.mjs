// Model settings and the background model (docs/MODELS.md). The owner picks a default model and
// effort for new chats, and an optional cheap background model that names chats and writes a
// one-line summary of long runs of tool steps. Background work never blocks a reply: it runs
// after an answer, and any failure leaves the plain wording in place.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineExtension } from '@earendil-works/pi-durable';
import { nativeTitleDoc } from './orchestration.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** One-line summaries of long runs of tool steps, keyed like the UI's activity groups. */
export const SummaryDoc = defineDoc({ kind: 'mars.activity-summaries', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ items: {} }) });
export const SUMMARY_MIN_TOOLS = 3;
const SUMMARY_KEEP = 200;

export function createModelSettings({ file, resolve }) {
  let cache;
  async function read() {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(file, 'utf8')); } catch { cache = {}; }
    return cache;
  }
  return {
    read,
    /** { defaultModel, defaultEffort, backgroundModel }: each "" when unset. */
    async get() {
      const value = await read();
      return { defaultModel: value.defaultModel || '', defaultEffort: value.defaultEffort || '', backgroundModel: value.backgroundModel || '' };
    },
    async set(change = {}) {
      const next = { ...(await read()) };
      for (const key of ['defaultModel', 'backgroundModel']) {
        if (change[key] === undefined) continue;
        if (typeof change[key] !== 'string') throw fail(`${key} must be a model id or ""`);
        if (change[key] && !resolve(change[key])) throw fail(`Unknown model ${change[key]}`);
        next[key] = change[key];
      }
      if (change.defaultEffort !== undefined) {
        if (change.defaultEffort !== '' && !EFFORTS.includes(change.defaultEffort)) throw fail('defaultEffort must be an effort level or ""');
        next.defaultEffort = change.defaultEffort;
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(file + '.tmp', file);
      cache = next;
      return this.get();
    },
  };
}

const textOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : typeof message?.content === 'string' ? message.content : '').trim();
const toolsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === 'toolCall' || part.type === 'tool-call') : []);

/**
 * The activity groups the UI shows (apps/ui/lib/pi/live-state.ts parseSnapshot): a tool-only
 * assistant turn joins the next assistant message. Returns [{ key, tools: [{ name, arguments }] }]
 * where key is the UI's message id of the group (`<entryId>:<index>`).
 */
export function activityGroups(entries) {
  const groups = [];
  let open;
  for (const entry of entries) {
    if (entry.kind === 'mars.side-chat-done') { open = undefined; continue; }
    (entry.model ?? []).forEach((message, index) => {
      if (message.role === 'toolResult' || message.role === 'tool') return;
      if (message.role !== 'assistant' && message.role !== 'user') return;
      const text = textOf(message) || (typeof message.errorMessage === 'string' ? message.errorMessage : '');
      const tools = message.role === 'assistant' ? toolsOf(message) : [];
      const outcome = message.stopReason === 'error' || message.stopReason === 'aborted';
      if (!text && !tools.length && !outcome && message.role === 'assistant') return;
      if (message.role === 'user') { open = undefined; return; }
      if (open && !open.closed) {
        open.tools.push(...tools);
        if (text || outcome) open.closed = true;
        return;
      }
      open = { key: `${entry.id}:${index}`, tools: [...tools], closed: !!(text || outcome) || !tools.length };
      groups.push(open);
    });
  }
  return groups.map(({ key, tools }) => ({ key, tools: tools.map((tool) => ({ name: tool.name, arguments: tool.arguments })) }));
}

/** A short, privacy-minded line per tool call: the name and the start of its main argument. */
export function describeTool({ name, arguments: args }) {
  const main = args && typeof args === 'object' ? (args.command ?? args.path ?? args.query ?? args.url ?? args.code ?? args.task ?? args.name ?? '') : '';
  const flat = String(typeof main === 'string' ? main : JSON.stringify(main)).replace(/\s+/g, ' ').trim();
  return `${name}${flat ? ': ' + flat.slice(0, 120) : ''}`;
}

/** The background model's text answer, or '' when it fails. One short request, no tools. */
async function ask({ models, model, system, prompt, maxTokens = 120 }) {
  try {
    const stream = models.streamSimple(model, { systemPrompt: system, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, { maxTokens });
    const result = await stream.result();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') return '';
    return textOf(result).replace(/^["'\s]+|["'.\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
  } catch {
    return '';
  }
}

export function createBackground({ harness, models, settings, resolve, context = BACKGROUND_CONTEXT }) {
  const busy = new Set();
  async function model() {
    const { backgroundModel } = await settings.get();
    return backgroundModel ? resolve(backgroundModel) : undefined;
  }
  /** Replace an automatic title with a 3 to 6 word one, once. Owner renames are never touched. */
  async function title(conversation, entries, chosen) {
    const label = await harness().snapshot(nativeTitleDoc, conversation.id, context);
    if (!label?.auto || label.modelTitled) return false;
    const messages = entries.flatMap((entry) => entry.model ?? []);
    const user = textOf(messages.find((m) => m.role === 'user')).slice(0, 600);
    const reply = textOf(messages.find((m) => m.role === 'assistant' && textOf(m))).slice(0, 600);
    if (!user) return false;
    const name = await ask({ models, model: chosen, system: 'You name chat conversations. Reply with only a title of 3 to 6 words in sentence case, no quotes, no full stop.', prompt: `First message:\n${user}\n\nFirst reply:\n${reply}` });
    if (!name) return false;
    return harness().commit(async (tx) => {
      const doc = await tx.doc(nativeTitleDoc, conversation.id);
      if (!doc.auto || doc.modelTitled) return false;
      doc.title = name;
      doc.modelTitled = true;
      return true;
    }, context);
  }
  /** Summarise up to three unsummarised groups of SUMMARY_MIN_TOOLS or more tool calls. */
  async function summaries(conversation, entries, chosen) {
    const done = (await harness().snapshot(SummaryDoc, conversation.id, context))?.items ?? {};
    const todo = activityGroups(entries).filter((group) => group.tools.length >= SUMMARY_MIN_TOOLS && !done[group.key]).slice(-3);
    let written = 0;
    for (const group of todo) {
      const steps = group.tools.slice(0, 40).map(describeTool).join('\n');
      const line = await ask({ models, model: chosen, system: 'You label a run of an agent\'s tool steps for a chat timeline. Reply with only one past-tense phrase of at most 8 words saying what was achieved, e.g. "Deployed the host and fixed the terminal test". No quotes, no full stop.', prompt: steps });
      if (!line) continue;
      await harness().commit(async (tx) => {
        const doc = await tx.doc(SummaryDoc, conversation.id);
        doc.items[group.key] = line;
        const keys = Object.keys(doc.items);
        for (const key of keys.slice(0, Math.max(0, keys.length - SUMMARY_KEEP))) delete doc.items[key];
      }, context);
      written++;
    }
    return written;
  }
  /** After a final answer: name the chat and summarise its long runs. Never throws. */
  async function after(conversationId) {
    const key = String(conversationId);
    if (busy.has(key)) return;
    busy.add(key);
    try {
      const chosen = await model();
      if (!chosen) return;
      // Helpers' own conversations are not shown as chats; leave them alone.
      const record = await harness().commit((tx) => tx.conversation(conversationId), context);
      if (!record || record.owner) return;
      const conversation = await harness().conversation(conversationId, context);
      if (!conversation) return;
      const view = await conversation.viewState(context);
      let entries;
      try { entries = structuredClone(view.value.entries); } finally { view.dispose(); }
      await title(conversation, entries, chosen);
      await summaries(conversation, entries, chosen);
    } catch {
      // Background naming is a convenience; the plain wording stays.
    } finally {
      busy.delete(key);
    }
  }
  return { after, title, summaries, model };
}

export function createBackgroundExtension({ background }) {
  return defineExtension({
    name: 'mars-background',
    hooks: [{
      task: 'pi.generation',
      handlers: {
        afterResponse: (message, api) => {
          if (message.stopReason !== 'stop') return;
          const id = api.conversationId;
          setImmediate(() => { void background.after(id); });
        },
      },
    }],
  });
}

/** Summaries for /api/state, keyed by the UI's activity group id. Read-only. */
export async function readSummaries(harness, conversationId, context) {
  return (await harness.snapshot(SummaryDoc, conversationId, context))?.items ?? {};
}

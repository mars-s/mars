// One chunker for every chat platform (docs/GATEWAY.md "Delivery"). Splits at paragraph,
// line, sentence, then space, then hard, and never leaves a code fence open across chunks:
// a fence cut in two is closed at the end of one chunk and reopened at the start of the next.
//
// Every pass takes at least one character off the text, so it always finishes: only the
// fence marker and a short language name are carried into the next chunk, never the whole
// opening line, and markers longer than MAX_MARK are plain text.

const MAX_MARK = 10; // longest fence marker treated as a fence
const MAX_INFO = 16; // longest language name reopened with a carried fence
const FENCE = new RegExp(`^\\s*(\`{3,${MAX_MARK}}(?!\`)|~{3,${MAX_MARK}}(?!~))(.*)$`);
const INFO = new RegExp(`^[\\w+#.-]{1,${MAX_INFO}}$`);
// Room kept free in every chunk to close a fence: "\n" plus up to MAX_MARK marks. A carried
// fence line is at most MAX_MARK + MAX_INFO + 1 characters, so with the 40 character minimum
// limit every chunk still has room for at least 2 characters of text.
const CLOSE_ROOM = 1 + MAX_MARK;

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

/** Index to cut `text` at, from 1 to `limit`, preferring the most natural break. */
function cutAt(text, limit) {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit);
  for (const pattern of [/\n\s*\n/g, /\n/g, /[.!?]\s/g, /\s/g]) {
    let last = -1;
    for (const match of window.matchAll(pattern)) last = match.index + match[0].length;
    if (last > limit * 0.3) return last;
  }
  // A hard cut never splits a character outside the Basic Multilingual Plane, such as an emoji.
  return limit > 1 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/** The line that reopens a fence: its marker, plus the language name when it is short. */
function reopenLine(match) {
  const info = match[2].trim();
  return match[1] + (INFO.test(info) ? info : '');
}
const markOf = (open) => FENCE.exec(open)[1];

/** The fence still open at the end of `text` (the line that reopens it, e.g. "\`\`\`js"), or null. */
function openFence(text, initial) {
  let open = initial;
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (!match) continue;
    if (!open) open = reopenLine(match);
    else if (match[1].startsWith(markOf(open)) && !match[2].trim()) open = null;
  }
  return open;
}

/** Split `text` into chunks of at most `limit` characters. Empty text gives []. */
export function chunkText(text, limit) {
  if (!Number.isInteger(limit) || limit < 40) throw Error('limit must be an integer of at least 40');
  const chunks = [];
  let rest = String(text ?? '').trim();
  let carried = null; // fence reopened at the start of this chunk
  while (rest) {
    const prefix = carried ? carried + '\n' : '';
    const room = limit - prefix.length - CLOSE_ROOM;
    const cut = Math.max(1, cutAt(rest, room));
    const body = rest.slice(0, cut).replace(/\s+$/, '');
    // Only line breaks are dropped at the start of the next chunk, so indented code keeps
    // its indentation.
    rest = rest.slice(cut).replace(/^\n+/, '');
    if (!body.trim()) continue; // nothing but spaces: no empty message, the fence stays as it was
    const open = openFence(body, carried);
    let chunk = prefix + body;
    if (open && rest) chunk += '\n' + markOf(open);
    chunks.push(chunk);
    carried = open && rest ? open : null;
  }
  return chunks;
}

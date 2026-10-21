// One chunker for every chat platform (docs/GATEWAY.md "Delivery"). Splits at paragraph,
// line, sentence, then space, then hard, and never leaves a code fence open across chunks:
// a fence cut in two is closed at the end of one chunk and reopened at the start of the next.

const FENCE = /^\s*(```+|~~~+)(.*)$/;

/** Index to cut `text` at, at most `limit`, preferring the most natural break. */
function cutAt(text, limit) {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit);
  for (const pattern of [/\n\s*\n/g, /\n/g, /[.!?]\s/g, /\s/g]) {
    let last = -1;
    for (const match of window.matchAll(pattern)) last = match.index + match[0].length;
    if (last > limit * 0.3) return last;
  }
  return limit;
}

/** The fence still open at the end of `text` (its marker, e.g. "```js"), or null. */
function openFence(text, initial) {
  let open = initial;
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (!match) continue;
    if (!open) open = line.trim();
    else if (match[1].startsWith(open.match(/^(```+|~~~+)/)[1]) && !match[2].trim()) open = null;
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
    const room = limit - prefix.length - 8; // room to close a fence: "\n" plus up to 7 marks
    const cut = cutAt(rest, room);
    const body = rest.slice(0, cut).replace(/\s+$/, '');
    rest = rest.slice(cut).replace(/^\s+/, '');
    const open = openFence(body, carried);
    let chunk = prefix + body;
    if (open && rest) chunk += '\n' + open.match(/^(```+|~~~+)/)[1];
    chunks.push(chunk);
    carried = open && rest ? open : null;
  }
  return chunks;
}

// Images placed in the message text (docs/IMAGE-CHIPS.md). The composer keeps each image as an
// assistant-ui directive, ":image[Image 1]{name=<id>}", which the Lexical input shows as a chip.
// The id is the draft attachment's id while composing and the host attachment id once sent.

const DIRECTIVE = /:image\[([^\]\n]{1,80})\]\{name=([A-Za-z0-9-]{1,80})\}/g;

export type ImageChip = { label: string; id: string; start: number; end: number };

export const imageDirective = (label: string, id: string) => `:image[${label}]{name=${id}}`;

export function imageChips(text: string): ImageChip[] {
  return [...text.matchAll(DIRECTIVE)].map((match) => ({
    label: match[1],
    id: match[2],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** "Image N", one more than the highest number already in the text. */
export function nextImageLabel(text: string): string {
  const numbers = imageChips(text).map((chip) => Number(/^Image (\d+)$/.exec(chip.label)?.[1] ?? 0));
  return `Image ${Math.max(0, ...numbers) + 1}`;
}

/** Point each chip at its host attachment id; a chip whose image is gone keeps only its label. */
export function resolveImageChips(text: string, hostIds: ReadonlyMap<string, string>): string {
  return text.replace(DIRECTIVE, (_whole, label: string, id: string) => {
    const host = hostIds.get(id);
    return host ? imageDirective(label, host) : `[${label}]`;
  });
}

/** The text with its image chips taken out. */
export const withoutImageChips = (text: string) => text.replace(DIRECTIVE, "");

/** The text a person reads: each chip becomes "[Image 1]". */
export const plainImageChips = (text: string) => text.replace(DIRECTIVE, (_whole, label: string) => `[${label}]`);

// The host writes this line before each image it sends (packages/pi-host/image-store.mjs).
const ATTACHMENT_LINE = /^Attachment ([a-f0-9]{64}): (.*?)(?: \[(Image \d+)\])?$/;

export function parseAttachmentLine(text: string): { id: string; name: string; label: string } | null {
  const match = ATTACHMENT_LINE.exec(text.trim());
  return match ? { id: match[1], name: match[2], label: match[3] ?? "" } : null;
}

export type ImageRef = { id: string; name: string; url: string };
export type UserPart = { type: "text"; text: string } | { type: "image"; image: ImageRef; label: string };

/**
 * A sent message's text in reading order, each image where the host placed it. The host joins
 * its text blocks with newlines, so every image is one "Attachment <id>: ..." line; images it
 * listed without a line (older messages) follow the text.
 */
export function userParts(text: string, images: readonly ImageRef[]): UserPart[] {
  const byId = new Map(images.map((image) => [image.id, image]));
  const parts: UserPart[] = [];
  const shown = new Set<string>();
  let lines: string[] = [];
  const flush = () => {
    const joined = lines.join("\n").trim();
    if (joined) parts.push({ type: "text", text: joined });
    lines = [];
  };
  const place = (image: ImageRef, label: string) => {
    flush();
    shown.add(image.id);
    parts.push({ type: "image", image, label });
  };
  for (const line of text.split("\n")) {
    const attachment = parseAttachmentLine(line);
    const image = attachment && byId.get(attachment.id);
    if (attachment && image) {
      place(image, attachment.label);
      continue;
    }
    // Chips still in the text (a message the host has not rewritten yet) are placed the same way.
    let from = 0;
    let rest = "";
    for (const chip of imageChips(line)) {
      const chipImage = byId.get(chip.id);
      rest += line.slice(from, chip.start);
      from = chip.end;
      if (!chipImage) {
        rest += `[${chip.label}]`;
        continue;
      }
      lines.push(rest);
      rest = "";
      place(chipImage, chip.label);
    }
    lines.push(rest + line.slice(from));
  }
  flush();
  for (const image of images) if (!shown.has(image.id)) parts.push({ type: "image", image, label: "" });
  return parts;
}

/** Text of a sent or queued message without the host's attachment lines. */
export const withoutAttachmentLines = (text: string) =>
  text.split("\n").filter((line) => !parseAttachmentLine(line)).join("\n").trim();

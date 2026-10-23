# Images in the message text

The owner can put an image exactly where it belongs in a message ("make this [Image 1] look
like [Image 2]"). Each image shows as a chip in the composer, and the sent message shows each
image where it was placed. The model receives each image at that point in the text.

## Composer

The composer input is assistant-ui's Lexical input (`@assistant-ui/react-lexical`
`LexicalComposerInput`), which shows assistant-ui directives as inline chips that move,
select, copy and delete as one unit. An image chip is the directive
`:image[Image 1]{name=<draft attachment id>}`.

- Every image added to the draft, pasted, dropped or chosen with the attach button, gets a
  chip at the cursor, numbered after the highest number already in the text.
  (`components/composer/image-chips.tsx`, `ImageChipsPlugin`.) The Lexical input does not
  attach pasted images by itself, so the plugin does.
- The chip shows a small thumbnail and its label (`ImageChip`).
- Deleting a chip removes its image. Removing an image from the tray removes its chip
  (`removeImageChip`, which edits the editor directly).
- A file keeps its draft attachment id when a draft is put back (switching chats, a failed
  send), so its chip still names it (`lib/pi/image-attachments.ts`).
- The slash menu takes Enter and the arrow keys in the capture phase, before the editor.

## Sending

`onNew` (`components/live-workspace.tsx`) rewrites each chip to name the uploaded host
attachment, `:image[Image 1]{name=<64 hex id>}`; a chip whose image is gone becomes its label,
`[Image 1]`. `attachmentIds` lists the images in the order the attachments were added.

## Host

`createImageStore().content(ids, text)` (`packages/pi-host/image-store.mjs`) builds the model
input in reading order: the text before a chip, then that image's line
`Attachment <id>: <name> [Image 1]` and the image, then the text after it. Images without a
chip follow the text as before, and a message without chips is unchanged. Titles use the
text with each chip as its label (`plainImageChips`). Check: `check-image-chips.mjs`.

## Transcript

A sent message renders its parts in order (`userParts` in `lib/pi/image-chips.ts`): text,
and each image where the host placed it, captioned with its label. The host's attachment lines
are not shown. Images of older messages, which the host listed after the text, show after it.

## Checks

`tests/image-chips.test.mjs` (parsing), `tests/image-chips-ui-check.mjs` (paste, chips,
delete both ways, the sent text, the transcript), `check-image-chips.mjs` (host order).

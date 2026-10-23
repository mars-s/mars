"use client";

import { useEffect, useRef, useState } from "react";
import { unstable_defaultDirectiveFormatter, useAui, useAuiState } from "@assistant-ui/react";
import { $createDirectiveNodeWithFormatter, $isDirectiveNode, type DirectiveChipProps } from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { imageChips } from "@/lib/pi/image-chips";

/*
 * Images in the message text (docs/IMAGE-CHIPS.md). Every image attached to the draft, pasted,
 * dropped or chosen, gets a chip where the cursor is: assistant-ui's directive
 * ":image[Image 1]{name=<draft id>}", which its Lexical input shows as one unit. Deleting the
 * chip removes the image, and removing the image from the tray removes its chip.
 */
// The mounted composer's editor, so the image tray can remove a chip. Setting the composer text
// from outside is not always applied to an editor that has focus, so the tray edits the editor.
let current: LexicalEditor | null = null;

/** Remove the chips for one image (and the space after each) from the composer. */
export function removeImageChip(id: string) {
  current?.update(() => {
    const nodes = $getRoot().getChildren().flatMap((paragraph) => ($isElementNode(paragraph) ? paragraph.getChildren() : []));
    (window as unknown as { __dbg: unknown }).__dbg = { id, nodes: nodes.map((n) => n.getType() + ($isDirectiveNode(n) ? ":" + n.getDirectiveItem().id : "")), editors: document.querySelectorAll('[aria-label="Message Mars"]').length };
    for (const node of nodes) {
      if (!$isDirectiveNode(node) || node.getDirectiveItem().id !== id) continue;
      const next = node.getNextSibling();
      if ($isTextNode(next) && next.getTextContent().startsWith(" ")) {
        if (next.getTextContent() === " ") next.remove();
        else next.setTextContent(next.getTextContent().slice(1));
      }
      node.remove();
    }
  });
}

export function ImageChipsPlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();
  const ids = useAuiState((state) => state.composer.attachments.map((attachment) => attachment.id).join(" "));
  const text = useAuiState((state) => state.composer.text);
  // Ids given a chip here, and ids whose chip has reached the text (only those can be "deleted").
  // Removing an image from the tray removes its chip there (withoutImageChip), not here: while a
  // draft is put back the text and the images arrive one after the other.
  const chipped = useRef(new Set<string>());
  const shown = useRef(new Set<string>());
  // Images on their way out after their chip was deleted: never given a new chip.
  const removing = useRef(new Set<string>());
  const last = useRef(0);

  useEffect(() => editor.setEditable(editable), [editor, editable]);
  useEffect(() => {
    current = editor;
    return () => {
      if (current === editor) current = null;
    };
  }, [editor]);

  // A textarea attaches pasted images by itself; the Lexical input leaves that to us.
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const files = "clipboardData" in event ? [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/")) : [];
          if (!files.length) return false;
          event.preventDefault();
          for (const file of files) void aui.composer.addAttachment(file).catch(() => {});
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, aui],
  );

  useEffect(() => {
    const attached = ids ? ids.split(" ") : [];
    const chips = imageChips(text);
    const inText = new Set(chips.map((chip) => chip.id));
    for (const id of inText) shown.current.add(id);
    // Number new chips after the highest in the text, once the text has caught up with ours.
    if ([...chipped.current].every((id) => inText.has(id) || !attached.includes(id)))
      last.current = Math.max(0, ...chips.map((chip) => Number(/^Image (\d+)$/.exec(chip.label)?.[1] ?? 0)));
    // A chip the owner deleted takes its image with it.
    for (const id of removing.current) if (!attached.includes(id)) removing.current.delete(id);
    for (const id of attached)
      if (shown.current.has(id) && !inText.has(id)) {
        shown.current.delete(id);
        chipped.current.delete(id);
        removing.current.add(id);
        // Sending clears the text and the images in turn; the image may be gone already.
        try {
          void aui.composer.attachment({ id }).remove().catch(() => {});
        } catch {
          /* already removed */
        }
      }
    const fresh = attached.filter((id) => !chipped.current.has(id) && !inText.has(id) && !removing.current.has(id));
    if (!fresh.length) return;
    editor.update(() => {
      let selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        $getRoot().selectEnd();
        selection = $getSelection();
      }
      if (!$isRangeSelection(selection)) return;
      for (const id of fresh) {
        const number = ++last.current;
        chipped.current.add(id);
        selection.insertNodes([
          $createDirectiveNodeWithFormatter({ id, type: "image", label: `Image ${number}` }, unstable_defaultDirectiveFormatter),
          $createTextNode(" "),
        ]);
      }
    });
  }, [ids, text, editor, aui]);
  return null;
}

/** The chip inside the input: a small thumbnail and the label. */
export function ImageChip({ directiveId, directiveType, label }: DirectiveChipProps) {
  const file = useAuiState((state) => state.composer.attachments.find((attachment) => attachment.id === directiveId)?.file);
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <span className="live-image-chip" data-type={directiveType} title={file?.name ?? label}>
      {url && <img src={url} alt="" />}
      <span>{label}</span>
    </span>
  );
}

"use client";
import { AttachmentPrimitive, useAuiState } from "@assistant-ui/react";
import { removeImageChip } from "@/components/composer/image-chips";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

const STATUS = { running: "Uploading…", incomplete: "Upload failed", "requires-action": "Ready", complete: "Ready" } as const;

export function LiveImageAttachment() {
  const attachment = useAuiState((state) => state.attachment);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!attachment.file) return;
    const url = URL.createObjectURL(attachment.file);
    // The preview belongs to this mounted draft, rather than the server transcript.
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.file]);
  return (
    <AttachmentPrimitive.Root className="live-image-draft" data-status={attachment.status.type}>
      <span className="live-image-draft-thumb">
        {preview && (
          <a href={preview} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}>
            <img src={preview} alt={attachment.name} />
          </a>
        )}
        <AttachmentPrimitive.Remove
          aria-label={`Remove ${attachment.name}`}
          className="live-image-draft-remove"
          // Its chip in the text goes with it (docs/IMAGE-CHIPS.md).
          onClick={() => removeImageChip(attachment.id)}
        >
          <X size={12} strokeWidth={2.5} aria-hidden="true" />
        </AttachmentPrimitive.Remove>
      </span>
      <span className="live-image-draft-meta">
        <span className="live-image-draft-name">{attachment.name}</span>
        <small>{STATUS[attachment.status.type]}</small>
      </span>
    </AttachmentPrimitive.Root>
  );
}

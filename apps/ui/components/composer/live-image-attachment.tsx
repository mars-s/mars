"use client";
import { AttachmentPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

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
    <AttachmentPrimitive.Root className="live-image-draft">
      {preview && (
        <a href={preview} target="_blank" rel="noreferrer">
          <img src={preview} alt={attachment.name} />
        </a>
      )}
      <span>
        {attachment.name}
        <small>
          {attachment.status.type === "running"
            ? "Uploading…"
            : attachment.status.type === "incomplete"
              ? "Upload failed"
              : "Ready"}
        </small>
      </span>
      <AttachmentPrimitive.Remove aria-label={`Remove ${attachment.name}`} className="live-icon">
        <X size={14} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

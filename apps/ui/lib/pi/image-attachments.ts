import type { AttachmentAdapter, PendingAttachment } from "@assistant-ui/react";
import { parseImages, record } from "./live-state";

export function createImageAdapter(
  onError: (message: string) => void,
  count: () => number = () => 0,
): AttachmentAdapter {
  const uploads = new WeakMap<File, Promise<ReturnType<typeof parseImages>[number]>>();
  const files = new Set<File>();
  // A file keeps its id when a draft is put back, so its chip in the text still names it.
  const ids = new WeakMap<File, string>();
  async function upload(attachment: PendingAttachment, signal?: AbortSignal) {
    const existing = uploads.get(attachment.file);
    if (existing) return existing;
    const pending = (async () => {
      const response = await fetch("/api/attachments", {
        method: "POST",
        headers: {
          "content-type": attachment.file.type,
          "x-file-name": encodeURIComponent(attachment.name),
        },
        body: attachment.file,
        signal,
      });
      const data: unknown = await response.json();
      const receipt = parseImages([record(data).attachment])[0];
      if (!response.ok || !receipt)
        throw Error(
          typeof record(data).error === "string"
            ? String(record(data).error)
            : "Image upload failed. Remove it and try again.",
        );
      return receipt;
    })();
    uploads.set(attachment.file, pending);
    try {
      return await pending;
    } catch (error) {
      uploads.delete(attachment.file);
      throw error;
    }
  }

  return {
    accept: "image/jpeg,image/png,image/webp,image/gif",
    async *add({ file }) {
      const failure = !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)
        ? "Choose a JPEG, PNG, WebP or GIF image."
        : file.size > 10 * 1024 * 1024
          ? "Images must be 10 MiB or smaller."
          : Math.max(files.size, count()) >= 4 && !files.has(file)
            ? "Attach up to four images per message."
            : "";
      if (failure) {
        onError(failure);
        throw Error(failure);
      }
      files.add(file);
      if (!ids.has(file)) ids.set(file, crypto.randomUUID());
      const attachment: PendingAttachment = {
        id: ids.get(file)!,
        type: "image",
        name: file.name,
        file,
        contentType: file.type,
        status: { type: "requires-action", reason: "composer-send" },
      };
      yield { ...attachment, status: { type: "running", reason: "uploading", progress: 0 } };
      try {
        await upload(attachment);
        yield attachment;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image upload failed.";
        onError(message);
        yield { ...attachment, status: { type: "incomplete", reason: "error", message } };
      }
    },
    async send(attachment, options) {
      try {
        const receipt = await upload(attachment, options?.signal);
        files.delete(attachment.file);
        return {
          ...attachment,
          status: { type: "complete" },
          content: [{ type: "image", image: receipt.url, filename: receipt.name }],
        };
      } catch (error) {
        onError(error instanceof Error ? error.message : "Image upload failed.");
        throw error;
      }
    },
    async remove(attachment) {
      if (attachment.file) files.delete(attachment.file);
    },
  };
}

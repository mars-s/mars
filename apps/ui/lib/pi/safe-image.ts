/**
 * Images in a reply load only from Mars itself (or inline data). A remote address would load the
 * moment the reply renders, so a prompt injection could make the model leak data in its URL;
 * such an image shows as a link instead (components/thread/messages.tsx).
 */
export function safeImageSource(src: unknown): string {
  if (typeof src !== "string") return "";
  if (/^\/(?!\/)/.test(src) || /^(data:image\/|blob:)/i.test(src)) return src;
  return "";
}

/** The host of a remote image address, or "" when it is not one. */
export function remoteImageHost(src: unknown): string {
  if (typeof src !== "string" || !/^https?:\/\//i.test(src)) return "";
  try {
    return new URL(src).host;
  } catch {
    return "";
  }
}

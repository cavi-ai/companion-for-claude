import { mediaKind, mediaMime, type MediaAttachment } from "../../context/attachments";

const interrupted = "Image attachment was interrupted. Paste or attach it again, or remove it from Message context.";
const unavailable = "This attachment has no saved file. Paste or attach it again, or remove it from Message context.";

/** Keep only reusable file references or explicit interruption metadata, never bytes. */
export function storedDraftMedia(media: readonly MediaAttachment[]): MediaAttachment[] {
  return media.map(item => {
    if (item.path && !item.pending && !item.error) return { label: item.label, kind: item.kind, mime: item.mime, path: item.path };
    return { label: item.label.slice(0, 255), kind: item.kind, mime: item.kind === "pdf" ? "application/pdf" : "image/png", error: (item.pending ? interrupted : item.error || unavailable).slice(0, 2000) };
  });
}

/** Saved errors are inert source markers; they never supply a wire payload. */
export function restoredDraftMedia(value: unknown): MediaAttachment[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const { path, label, kind, error } = value as Record<string, unknown>;
  if (typeof label !== "string" || (kind !== "image" && kind !== "pdf")) return [];
  if (typeof error === "string" && error.trim()) return [{ label: label.slice(0, 255), kind, mime: kind === "pdf" ? "application/pdf" : "image/png", error: error.slice(0, 2000) }];
  if (typeof path !== "string" || mediaKind(path) !== kind) return [];
  return [{ path, label, kind, mime: mediaMime(path) }];
}

/** Refuse unresolved draft sources before accepting a request. */
export function draftMediaIssue(media: readonly MediaAttachment[]): string | null {
  const item = media.find(source => source.pending || source.error);
  if (!item) return null;
  return `${item.label}: ${item.pending ? "An image is still attaching. Wait for it to finish." : item.error} Reattach it or remove it from Message context, then send again.`;
}

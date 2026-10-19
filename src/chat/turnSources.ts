import type { MediaAttachment } from "../context/attachments";
import type { AttachedPath } from "../context/vaultContext";
import { MAX_PAGE_CONTEXT_CHARS, snapshotPages, type AttachedPage } from "../context/urlContext";
import type { ChatMessage } from "../types";

/** Durable metadata only; pasted bytes stay in memory while their message is live. */
export type TurnMediaReference = Omit<MediaAttachment, "data">;
const payloads = new WeakMap<TurnMediaReference[], MediaAttachment[]>();
// In-flight turns can still hold an older immutable message snapshot after a move.
const renamed = new WeakMap<object, object>();

export interface TurnContextAttachments { paths: AttachedPath[]; pages: AttachedPage[] }

export function currentSourceReferences<T extends object>(refs: T[]): T[] {
  let next: object | undefined;
  while ((next = renamed.get(refs))) refs = next as T[];
  return refs;
}

function renameReferences<T extends { path?: string; label?: string }>(refs: T[], oldPath: string, newPath: string): T[] {
  refs = currentSourceReferences(refs);
  const moved = (path?: string) => typeof path === "string" && (path === oldPath || path.startsWith(`${oldPath}/`));
  if (!refs.some((ref) => ref && moved(ref.path))) return refs;
  const next = refs.map((ref) => {
    if (!ref || !moved(ref.path)) return ref;
    const path = newPath + ref.path!.slice(oldPath.length);
    return { ...ref, path, ...(typeof ref.label === "string" ? { label: path.split("/").pop() ?? path } : {}) };
  });
  renamed.set(refs, next);
  return next;
}

export function renameTurnMedia(refs: TurnMediaReference[], oldPath: string, newPath: string): TurnMediaReference[] {
  const original = currentSourceReferences(refs);
  const next = renameReferences(original, oldPath, newPath);
  const cached = payloads.get(original);
  if (next !== original && cached) payloads.set(next, cached.map((item, i) => {
    const ref = next[i]!;
    return { ...item, label: ref.label, ...(ref.path ? { path: ref.path } : {}) };
  }));
  return next;
}

export function currentTurnContext(context: TurnContextAttachments): TurnContextAttachments {
  if (!context || !Array.isArray(context.paths)) return context;
  const paths = currentSourceReferences(context.paths);
  return paths === context.paths ? context : { ...context, paths };
}

export function renameTurnContext(context: TurnContextAttachments, oldPath: string, newPath: string): TurnContextAttachments {
  if (!context || !Array.isArray(context.paths)) return context;
  const paths = renameReferences(context.paths, oldPath, newPath);
  return paths === context.paths ? context : { ...context, paths };
}

export function rememberTurnContext(paths: readonly AttachedPath[], pages: readonly AttachedPage[]): TurnContextAttachments {
  return { paths: paths.map(({ path, kind }) => ({ path, kind })), pages: snapshotPages(pages).map(({ url, title, markdown }) => ({ url, markdown: markdown.slice(0, MAX_PAGE_CONTEXT_CHARS), ...(title !== undefined ? { title } : {}) })) };
}

export function readTurnContext(messages: readonly ChatMessage[]): TurnContextAttachments {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (user?.contextAttachments === undefined) {
    if (Array.isArray(user?.contextSources) && user.contextSources.some((source) => typeof source === "string" && /^\d+ (?:attached|pages?)$/.test(source))) throw new Error("Original note or page references were not saved. Reattach them and resend the question.");
    return { paths: [], pages: [] };
  }
  const context = currentTurnContext(user.contextAttachments);
  if (!context || !Array.isArray(context.paths) || !Array.isArray(context.pages)
    || context.paths.some((item) => !item || typeof item.path !== "string" || !item.path || (item.kind !== "note" && item.kind !== "folder"))
    || context.pages.some((page) => {
      if (!page || typeof page.url !== "string" || typeof page.markdown !== "string" || (page.title !== undefined && typeof page.title !== "string")) return true;
      try { return !["http:", "https:"].includes(new URL(page.url).protocol); } catch { return true; }
    })) throw new Error("Original note or page references are invalid. Reattach them and resend the question.");
  return rememberTurnContext(context.paths, context.pages);
}

export function rememberTurnMedia(media: readonly MediaAttachment[]): TurnMediaReference[] {
  const refs = media.map(({ label, kind, mime, path }) => ({ label, kind, mime, ...(path ? { path } : {}) }));
  payloads.set(refs, [...media]);
  return refs;
}

/** Resolve the last accepted question, independently of the next question's composer. */
export function readTurnMedia(messages: readonly ChatMessage[]): MediaAttachment[] {
  const stored = [...messages].reverse().find((message) => message.role === "user")?.media;
  if (stored === undefined) return [];
  if (!Array.isArray(stored)) throw new Error("Original attachments are invalid. Reattach them and resend the question.");
  const refs = currentSourceReferences(stored);
  for (const ref of refs) {
    if (!ref || (ref.kind !== "image" && ref.kind !== "pdf") || typeof ref.label !== "string" || typeof ref.mime !== "string" || (ref.path !== undefined && (typeof ref.path !== "string" || !ref.path))) {
      throw new Error("Original attachments are invalid. Reattach them and resend the question.");
    }
  }
  let media = payloads.get(refs);
  if (!media) {
    media = refs.map(({ label, kind, mime, path }) => {
      if (!path) throw new Error(`Original attachment ${label} is no longer available. Paste it again and resend the question.`);
      return { label, kind, mime, path };
    });
    payloads.set(refs, media);
  }
  return [...media];
}

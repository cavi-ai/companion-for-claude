import type { ContextToggles } from "../../types";
import type { AttachedPath } from "../../context/vaultContext";
import type { Composer } from "./Composer";
import { storedDraftMedia, restoredDraftMedia } from "./draftMediaState";
import { MAX_PAGE_CONTEXT_CHARS, type AttachedPage } from "../../context/urlContext";

export type DraftSources = Pick<Composer, "attachedPaths" | "attachedMedia" | "attachedPages">;
export type DraftContext = DraftSources & Pick<Composer, "contextToggles">;
type ContextHost = DraftContext & Pick<Composer, "renderContextManager">;
const AUTOMATIC = ["activeNote", "selection", "linkedNotes", "searchVault"] as const;

function storedPage(page: AttachedPage): AttachedPage {
  const error = page.pending ? "Page capture was interrupted. Retry capture to attach the page." : page.error || (!page.markdown.trim() ? "No readable content on that page." : undefined);
  return { url: page.url, markdown: error ? "" : page.markdown.slice(0, MAX_PAGE_CONTEXT_CHARS), ...(page.title !== undefined ? { title: page.title } : {}), ...(error ? { error } : {}) };
}

function restoredPage(value: unknown): AttachedPage[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const { url, markdown, title, error, pending } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof markdown !== "string") return [];
  try { if (!["http:", "https:"].includes(new URL(url).protocol)) return []; }
  catch { return []; }
  return [storedPage({ url, markdown, ...(typeof title === "string" ? { title } : {}), ...(typeof error === "string" ? { error } : {}), ...(pending === true ? { pending } : {}) })];
}

/** Serialize explicit sources without inline image bytes or tab-wide preferences. */
export function draftSourcesState(host: DraftSources) {
  const media = storedDraftMedia(host.attachedMedia);
  return { paths: host.attachedPaths.map((entry) => ({ ...entry })), media, pages: host.attachedPages.map(storedPage) };
}

/** Persist explicit sources and the current pane context alongside its draft. */
export function draftContextState(host: DraftContext, defaults: ContextToggles): Record<string, unknown> {
  const sources = draftSourcesState(host);
  if (!sources.paths.length && !sources.media.length && !sources.pages.length && AUTOMATIC.every((key) => host.contextToggles[key] === defaults[key])) return {};
  return { context: { automatic: { ...host.contextToggles }, ...sources } };
}

export function readDraftContext(fallback: DraftContext, state: unknown): DraftContext | null {
  const context = (state as { context?: unknown } | null)?.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const host: DraftContext = { contextToggles: { ...fallback.contextToggles }, attachedPaths: fallback.attachedPaths, attachedMedia: fallback.attachedMedia, attachedPages: fallback.attachedPages };
  const { automatic, paths, media, pages } = context as Record<string, unknown>;
  if (automatic && typeof automatic === "object" && !Array.isArray(automatic)) {
    const toggles = { ...host.contextToggles };
    for (const key of AUTOMATIC) {
      const value = (automatic as Record<string, unknown>)[key];
      if (typeof value === "boolean") toggles[key] = value;
    }
    host.contextToggles = toggles;
  }
  if (Array.isArray(paths)) {
    host.attachedPaths = paths.filter((entry: unknown): entry is AttachedPath => {
      if (!entry || typeof entry !== "object") return false;
      const { path, kind } = entry as Record<string, unknown>;
      return typeof path === "string" && path.length > 0 && (kind === "note" || kind === "folder");
    }).map(({ path, kind }) => ({ path, kind }));
  }
  if (Array.isArray(media)) host.attachedMedia = media.flatMap(restoredDraftMedia);
  if (Array.isArray(pages)) host.attachedPages = pages.flatMap(restoredPage);
  return host;
}

export function restoreDraftContext(host: ContextHost, state: unknown): boolean {
  const context = readDraftContext(host, state);
  if (!context) return false;
  Object.assign(host, context);
  host.renderContextManager();
  return true;
}

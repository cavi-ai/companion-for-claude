import type { MediaAttachment } from "../context/attachments";
import { pageLabel, type AttachedPage } from "../context/urlContext";
import type { AttachedPath } from "../context/vaultContext";
import type { ContextToggles } from "../types";

export type AutomaticContextKey = keyof ContextToggles;
export type ContextSourceKind = "note" | "folder" | "project" | "pdf" | "image" | "webpage";
export type ContextSourceStatus = "ready" | "pending" | "error";

export interface AutomaticContextItem {
  key: AutomaticContextKey;
  label: string;
  enabled: boolean;
  detail?: string;
}

export interface AddedContextItem {
  id: string;
  kind: ContextSourceKind;
  label: string;
  detail?: string;
  status: ContextSourceStatus;
  error?: string;
}

export interface ContextManagerModel {
  activeCount: number;
  summary: string;
  automatic: AutomaticContextItem[];
  sources: AddedContextItem[];
  signature: string;
}

export interface ContextManagerInput {
  toggles: ContextToggles;
  activeNotePath: string | null;
  paths: readonly AttachedPath[];
  media: readonly MediaAttachment[];
  pages: readonly AttachedPage[];
}

const AUTOMATIC: ReadonlyArray<readonly [AutomaticContextKey, string]> = [
  ["activeNote", "This note"],
  ["selection", "Selection"],
  ["linkedNotes", "Linked notes"],
  ["searchVault", "Entire vault"],
];

function sourceName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function isProjectPath(path: string): boolean {
  return /(^|\/)Project\.md$/i.test(path);
}

export function buildContextManagerModel(input: ContextManagerInput): ContextManagerModel {
  const automatic: AutomaticContextItem[] = AUTOMATIC.map(([key, label]) => ({
    key,
    label,
    enabled: input.toggles[key],
    ...(key === "activeNote" && input.activeNotePath ? { detail: input.activeNotePath } : {}),
  }));
  const pathSources: AddedContextItem[] = input.paths.map((item) => ({
    id: `path:${item.kind}:${item.path}`,
    kind: item.kind === "folder" ? "folder" : isProjectPath(item.path) ? "project" : "note",
    label: sourceName(item.path),
    detail: item.path,
    status: "ready",
  }));
  const mediaSources: AddedContextItem[] = input.media.map((item, index) => ({
    id: `media:${item.kind}:${item.path ?? `inline:${index}`}`,
    kind: item.kind,
    label: item.label,
    ...(item.path ? { detail: item.path } : {}),
    status: "ready",
  }));
  const pageSources: AddedContextItem[] = input.pages.map((item) => {
    const fallbackLabel = pageLabel(item.url);
    return {
      id: `page:${item.url}`,
      kind: "webpage",
      label: item.title ?? fallbackLabel,
      ...(item.title ? { detail: fallbackLabel } : {}),
      status: item.pending ? "pending" : item.error ? "error" : "ready",
      ...(item.error ? { error: item.error } : {}),
    };
  });
  const sources = [...pathSources, ...mediaSources, ...pageSources];
  const activeLabels = [
    ...automatic.filter((item) => item.enabled).map((item) => item.label),
    ...sources.map((item) => item.label),
  ];
  const activeCount = activeLabels.length;
  const primary = activeLabels[0];
  const summary = activeCount === 0
    ? "Add context"
    : primary && primary.length <= 32
      ? activeCount === 1
        ? `Context · ${primary}`
        : `Context · ${primary} + ${activeCount - 1}`
      : `Context · ${activeCount}`;
  const visible = { activeCount, summary, automatic, sources };
  return { ...visible, signature: JSON.stringify(visible) };
}

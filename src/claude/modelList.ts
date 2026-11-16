import type { ClaudeModel } from "../types";

export interface FetchedModel {
  id: string;
  label: string;
  /** ISO creation time reported by the Models API. */
  created?: string;
}

/** Read a `GET /v1/models` response; entries that are not models are ignored. */
export function parseModelList(json: unknown): FetchedModel[] {
  if (typeof json !== "object" || json === null) return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: FetchedModel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, type, display_name, created_at } = entry as Record<string, unknown>;
    if (type !== "model" || typeof id !== "string" || id.trim() === "") continue;
    const name = typeof display_name === "string" && display_name.trim() !== "" ? display_name.trim() : id.trim();
    out.push({ id: id.trim(), label: name, ...(typeof created_at === "string" ? { created: created_at } : {}) });
  }
  return out;
}

function createdMs(model: FetchedModel): number {
  const ms = model.created ? Date.parse(model.created) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Curated entries first (keeping label and hint), then fetched-only models newest first. */
export function mergeModelLists(fetched: FetchedModel[], curated: ClaudeModel[]): ClaudeModel[] {
  const seen = new Set(curated.map((m) => m.id));
  const extra: FetchedModel[] = [];
  for (const model of fetched) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    extra.push(model);
  }
  extra.sort((a, b) => createdMs(b) - createdMs(a));
  return [...curated, ...extra.map(({ id, label }) => ({ id, label }))];
}

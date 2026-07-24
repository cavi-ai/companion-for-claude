import type { ResearchDeskPreferences } from "./deskViewModel";

export type ResearchDeskPreferenceMap = Record<string, ResearchDeskPreferences>;

function preference(value: unknown): ResearchDeskPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const dismissedActionIds = [...new Set((Array.isArray(raw.dismissedActionIds) ? raw.dismissedActionIds : []).filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))];
  return { dismissedActionIds, ...(typeof raw.pinnedActionId === "string" && raw.pinnedActionId.trim() ? { pinnedActionId: raw.pinnedActionId.trim() } : {}) };
}

export function normalizeDeskPreferenceMap(value: unknown): ResearchDeskPreferenceMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ResearchDeskPreferenceMap = {};
  for (const [path, raw] of Object.entries(value)) {
    if (!path.trim()) continue;
    const normalized = preference(raw);
    if (normalized) result[path] = normalized;
  }
  return result;
}

export function dismissDeskAction(current: ResearchDeskPreferences, id: string): ResearchDeskPreferences {
  const dismissedActionIds = [...new Set([...current.dismissedActionIds, id])];
  return { dismissedActionIds, ...(current.pinnedActionId && current.pinnedActionId !== id ? { pinnedActionId: current.pinnedActionId } : {}) };
}

export function pinDeskAction(current: ResearchDeskPreferences, id: string): ResearchDeskPreferences {
  if (current.pinnedActionId === id) return { dismissedActionIds: [...current.dismissedActionIds] };
  return { dismissedActionIds: current.dismissedActionIds.filter((candidate) => candidate !== id), pinnedActionId: id };
}

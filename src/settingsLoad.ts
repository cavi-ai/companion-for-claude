// Pure persisted-data → settings resolution, split out of main.ts so legacy
// data.json shapes (flat pre-namespacing configs, pre-engine semantic users,
// pre-utilityBackend installs) are unit-testable without an Obsidian app.

import { DEFAULT_SETTINGS, migrateSystemPrompt, normalizeDiscoverySettings, type PluginSettings } from "./types";
import { migrateUtilityBackend } from "./providers/router";
import { migrateEmbeddingEngine } from "./semantic/embedder";

export interface NamespacedData {
  settings?: Partial<PluginSettings>;
  conversations?: unknown;
  researchDeskPreferences?: unknown;
}

/** True when data.json uses the namespaced { settings, conversations } shape
 * rather than the legacy flat shape (data.json *was* the settings object). */
export function isNamespacedData(raw: unknown): raw is NamespacedData {
  return !!raw && typeof raw === "object" && ("settings" in raw || "conversations" in raw || "researchDeskPreferences" in raw);
}

/** Merge persisted data over defaults, applying the legacy migrations. */
export function resolveSettings(raw: NamespacedData | Partial<PluginSettings> | null): PluginSettings {
  const settingsData = isNamespacedData(raw) ? raw.settings : raw;
  // Pre-engine semantic users are working Ollama users — keep them there
  // instead of letting the builtin default repoint their index. Persisted on
  // the next save, like the shape migration above.
  const migratedEngine = migrateEmbeddingEngine(settingsData);
  const migratedUtility = migrateUtilityBackend(settingsData);
  const migratedPrompt = migrateSystemPrompt(settingsData?.systemPrompt);
  return {
    ...DEFAULT_SETTINGS,
    ...settingsData,
    ...normalizeDiscoverySettings(settingsData ?? {}),
    ...(migratedEngine ? { embeddingEngine: migratedEngine } : {}),
    ...(migratedUtility ? { utilityBackend: migratedUtility } : {}),
    ...(migratedPrompt ? { systemPrompt: migratedPrompt } : {}),
    context: { ...DEFAULT_SETTINGS.context, ...(settingsData?.context ?? {}) },
  };
}

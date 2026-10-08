// Pure persisted-data → settings resolution, split out of main.ts so legacy
// data.json shapes (flat pre-namespacing configs, pre-engine semantic users,
// pre-utilityBackend installs) are unit-testable without an Obsidian app.

import { DEFAULT_SETTINGS, migrateSystemPrompt, type PluginSettings } from "./types";
import { migrateUtilityBackend } from "./providers/router";
import { migrateResearchModel } from "./research/researchModel";
import { migrateEmbeddingEngine } from "./semantic/embedder";

export interface NamespacedData {
  settings?: Partial<PluginSettings>;
  conversations?: unknown;
  buildRuns?: unknown;
  activeBuildRunId?: unknown;
  standingOrders?: unknown;
  orderEditQueue?: unknown;
  published?: unknown;
  optimize?: unknown;
}

/** True when data.json uses the namespaced { settings, conversations } shape
 * rather than the legacy flat shape (data.json *was* the settings object). */
export function isNamespacedData(raw: unknown): raw is NamespacedData {
  return !!raw && typeof raw === "object" && ("settings" in raw || "conversations" in raw || "buildRuns" in raw);
}

const REMOVED_SETTING_KEYS = ["artifactHeight", "discoveryMaxResults", "discoveryExpansionLimit", "discoveryCacheHours", "cloudRoutineBetaHeader", "intelligenceNarrator", "discoveryReranker"];

const withoutRemovedKeys = (data: Partial<PluginSettings>): Partial<PluginSettings> => {
  const kept: Record<string, unknown> = { ...data };
  for (const key of REMOVED_SETTING_KEYS) delete kept[key];
  return kept;
};

/** Merge persisted data over defaults, applying the legacy migrations. */
export function resolveSettings(raw: NamespacedData | Partial<PluginSettings> | null): PluginSettings {
  const settingsData = isNamespacedData(raw) ? raw.settings : raw;
  // Pre-engine semantic users are working Ollama users — keep them there
  // instead of letting the builtin default repoint their index. Persisted on
  // the next save, like the shape migration above.
  const migratedEngine = migrateEmbeddingEngine(settingsData);
  const migratedUtility = migrateUtilityBackend(settingsData);
  const migratedPrompt = migrateSystemPrompt(settingsData?.systemPrompt);
  const migratedResearch = migrateResearchModel(settingsData);
  // Sonnet 5 left the picker; its selection moves to Sonnet 5.5.
  const migratedModel = settingsData?.model === "claude-sonnet-5" ? "claude-sonnet-5-5" : undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...(settingsData ? withoutRemovedKeys(settingsData) : {}),
    ...(migratedEngine ? { embeddingEngine: migratedEngine } : {}),
    ...(migratedUtility ? { utilityBackend: migratedUtility } : {}),
    ...(migratedPrompt ? { systemPrompt: migratedPrompt } : {}),
    ...(migratedResearch ? { researchModel: migratedResearch } : {}),
    ...(migratedModel ? { model: migratedModel } : {}),
    context: { ...DEFAULT_SETTINGS.context, ...(settingsData?.context ?? {}) },
  };
}

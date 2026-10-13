// Settings diet: basic vs advanced. Tags every setting definition with a tier
// and gates advanced rows (and pages with nothing basic) behind the toggle.

import type { SettingDefinition, SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type { PluginSettings } from "../types";

export type SettingsTier = "basic" | "advanced";

/**
 * One tier per settings key. `Record<keyof PluginSettings, ...>` makes the
 * compiler refuse a build the moment a key is added to PluginSettings and
 * left out here — the actual coverage guarantee, independent of whether
 * every key happens to have a settings-tab row.
 */
const SETTING_TIERS: Record<keyof PluginSettings, SettingsTier> = {
  apiKey: "basic",
  authMode: "basic",
  oauthToken: "advanced",
  baseUrl: "advanced",
  model: "basic",
  customModel: "advanced",
  maxTokens: "advanced",
  systemPrompt: "advanced",
  artifactOpenTarget: "advanced",
  artifactFolder: "advanced",
  chatFolder: "advanced",
  planFolder: "advanced",
  templatesFolder: "advanced",
  context: "advanced",
  contextCharBudget: "advanced",
  maxContextNotes: "advanced",
  chatFontSize: "advanced",
  maxConversations: "advanced",
  ollamaHost: "advanced",
  ollamaModel: "advanced",
  ollamaUtilityModel: "advanced",
  utilityBackend: "advanced",
  classifierBackend: "advanced",
  classifierModel: "advanced",
  chatBackend: "basic",
  deviceChatModel: "basic",
  codexModel: "advanced",
  opencodeModel: "advanced",
  researchModel: "basic",
  openaiCompatHost: "advanced",
  openaiCompatModel: "advanced",
  openaiCompatKey: "advanced",
  openaiCompatEmbeddingModel: "advanced",
  discoveryEnabled: "basic",
  openAlexContactEmail: "advanced",
  zoteroUserId: "advanced",
  zoteroApiKey: "advanced",
  semanticEnabled: "basic",
  embeddingModel: "advanced",
  embeddingEngine: "advanced",
  builtinEmbeddingModel: "advanced",
  semanticModelPrompted: "advanced",
  semanticIndexPdfs: "advanced",
  autoTagOnSave: "advanced",
  artifactBaseTags: "advanced",
  chatBaseTags: "advanced",
  agentModeEnabled: "basic",
  agentAllowWrites: "basic",
  notifyOnTurnComplete: "basic",
  inlineDiffEnabled: "advanced",
  selectionActionEnabled: "advanced",
  agentMaxIterations: "advanced",
  agentAutoContinue: "advanced",
  standingOrdersEnabled: "basic",
  webSearchEnabled: "advanced",
  webSearchEngine: "advanced",
  braveSearchApiKey: "advanced",
  webFetchEnabled: "advanced",
  // The bridge's own page calls it an "optional advanced bridge" — "vault
  // tools connect" for a first-week user means the desktop-integrations flow.
  mcpEnabled: "advanced",
  mcpPort: "advanced",
  mcpToken: "advanced",
  mcpAllowWrites: "advanced",
  memoryRecordEnabled: "basic",
  mcpWriteFolder: "advanced",
  mcpClientServers: "advanced",
  cloudDispatchEnabled: "advanced",
  cloudRoutineFireUrl: "advanced",
  cloudRoutineToken: "advanced",
  cloudReplyRepo: "advanced",
  cloudReplyBranch: "advanced",
  cloudReplyFolder: "advanced",
  cloudReplyToken: "advanced",
  publishGithubToken: "basic",
  publishApiBase: "advanced",
  memoryEnabled: "advanced",
  memoryFolder: "advanced",
  memoryIngestOnSave: "advanced",
  memoryBaseTags: "advanced",
  memoryAutoConsolidate: "advanced",
  sourceCaptureEnabled: "basic",
  sourceEnrichOnCreate: "advanced",
  enrichmentDiagnostics: "advanced",
  sourceCaptureConsent: "advanced",
  sourceInboxFolder: "advanced",
  clipOrganizedFolder: "advanced",
  sourceBaseTags: "advanced",
  sourceSchemaOverrides: "advanced",
  clipperTemplateFingerprint: "advanced",
  clipperVerification: "advanced",
  ontologyEnabled: "basic",
  ontologyFolder: "advanced",
  ontologySeedPrompted: "advanced",
  desktopIntegrationsOffered: "advanced",
  setupWizardDone: "advanced",
  // Always basic: the toggle that reveals the rest must itself stay visible.
  settingsShowAdvanced: "basic",
};

/** Custom `render` rows with no `control.key`, promoted to basic by name. */
const BASIC_ACTION_NAMES: ReadonlySet<string> = new Set([
  "Codex model",
  "OpenCode model",
  "On-device model download",
  "Desktop integrations", // "vault tools connect"
  "Embedding model", // "semantic on/off + download"
  "Anthropic API key", // "credential" — the apiKey field itself is a custom render
  "Save & test connection", // what actually persists + verifies the credential
  "Step 1 — connect to Claude", // the one mandatory step, called out while it's missing
  "GitHub Gist token", // publishing needs it before anything else works
  "Test Gist token",
  "Published items",
]);

/** A page with zero basic items still shows with the toggle off when it configures the live setup. */
const PAGE_RELEVANCE: Record<string, (s: PluginSettings) => boolean> = {
  "Local models (Ollama & endpoints)": (s) =>
    s.chatBackend === "local" || s.chatBackend === "auto" || s.chatBackend === "custom" ||
    s.utilityBackend === "ollama" || s.utilityBackend === "custom" || s.classifierBackend !== "utility",
  "Agent bridge — MCP server (desktop)": (s) => s.mcpEnabled,
  "External tools — MCP client": (s) => s.mcpClientServers.length > 0,
  "Cloud (experimental)": (s) => s.cloudDispatchEnabled,
  "Session memory": (s) => s.memoryEnabled,
};

/** Only groups/lists/pages carry a `type` at all — leaf definitions (control/action/render/empty) don't. */
function isContainer(item: SettingDefinitionItem): item is Extract<SettingDefinitionItem, { type: "group" | "list" }> {
  return "type" in item && (item.type === "group" || item.type === "list");
}

function isPage(item: SettingDefinitionItem): item is Extract<SettingDefinitionItem, { type: "page" }> {
  return "type" in item && item.type === "page";
}

function leafTier(item: SettingDefinition): SettingsTier {
  const key = (item as unknown as { control?: { key?: string } }).control?.key;
  if (key && key in SETTING_TIERS) return SETTING_TIERS[key as keyof PluginSettings];
  return BASIC_ACTION_NAMES.has(item.name) ? "basic" : "advanced";
}

/** True if any leaf under `items` (through nested groups/pages) is basic-tier. */
function hasBasicItem(items: SettingDefinitionItem[] | undefined): boolean {
  if (!items) return false;
  return items.some((item) => (isContainer(item) || isPage(item) ? hasBasicItem(item.items) : leafTier(item) === "basic"));
}

function withExtraVisible(existing: boolean | (() => boolean) | undefined, extra: () => boolean): () => boolean {
  return () => extra() && (typeof existing === "function" ? existing() : existing ?? true);
}

/** One cast choke point for the rebuilt tier-tagged objects below. */
function asItem(value: object): SettingDefinitionItem { return value as SettingDefinitionItem; }

/**
 * Walks the declared tree and, per basic item 4/5: leaves basic items alone,
 * gates advanced items' visibility behind `showAdvanced`, and hides a page
 * entirely (until `showAdvanced`) when none of its items are basic.
 */
export function applyTiers(items: SettingDefinitionItem[], showAdvanced: () => boolean, settings: PluginSettings): SettingDefinitionItem[] {
  return items.map((item): SettingDefinitionItem => {
    if (isContainer(item)) {
      const inner = item.items ? (applyTiers(item.items, showAdvanced, settings) as unknown as SettingGroupItem[]) : item.items;
      return asItem({ ...item, items: inner });
    }
    if (isPage(item)) {
      const pageRelevant = hasBasicItem(item.items) || (PAGE_RELEVANCE[item.name]?.(settings) ?? false);
      const gated = pageRelevant ? { ...item } : { ...item, visible: withExtraVisible(item.visible, showAdvanced) };
      const inner = item.items ? applyTiers(item.items, showAdvanced, settings) : item.items;
      return asItem({ ...gated, items: inner });
    }
    const tier = leafTier(item);
    const out = tier === "basic" ? { ...item, tier } : { ...item, tier, visible: withExtraVisible(item.visible, showAdvanced) };
    return asItem(out);
  });
}

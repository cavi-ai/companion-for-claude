export type CompanionPage =
  | "chat"
  | "inbox"
  | "related"
  | "memory"
  | "research-desk"
  | "research-workbench";

export type ClipperStatus = "not-set-up" | "current" | "update-available";
export type QuickOptionKind = "toggle" | "select" | "text" | "status" | "action";

export interface QuickOptionChoice {
  value: string;
  label: string;
}

export interface QuickOptionDefinition {
  id: string;
  label: string;
  kind: QuickOptionKind;
  value?: string | boolean;
  description?: string;
  choices?: QuickOptionChoice[];
  actionLabel?: string;
}

export interface QuickOptionsState {
  chatBackend: "claude" | "local" | "auto" | "custom";
  chatModel: string;
  agentModeEnabled: boolean;
  vaultContextEnabled: boolean;
  memoryIngestOnSave: boolean;
  utilityBackend: "claude" | "ollama" | "custom";
  utilityEndpoint?: string;
  sourceEnrichOnCreate: boolean;
  sourceInboxFolder: string;
  sourceCaptureEnabled: boolean;
  clipperStatus: ClipperStatus;
  semanticEnabled: boolean;
  embeddingEngine: "builtin" | "ollama" | "custom";
  embeddingModel: string;
  embeddingHealth: string;
  indexHealth: string;
  memoryEnabled: boolean;
  memoryFolder: string;
  memoryAutoConsolidate: boolean;
  activeProject?: string;
  discoveryEnabled: boolean;
  activeResearchTab?: string;
  discoveryReranker: "current" | "claude" | "local" | "disabled";
}

export interface QuickOptionChange {
  id: string;
  value: string | boolean;
}

export interface QuickOptionAction {
  id: string;
  page: CompanionPage;
  activityId?: string;
}

const chatBackends: QuickOptionChoice[] = [
  { value: "auto", label: "Auto" },
  { value: "claude", label: "Claude" },
  { value: "local", label: "Local" },
  { value: "custom", label: "Custom endpoint" },
];

const utilityBackends: QuickOptionChoice[] = [
  { value: "claude", label: "Claude" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom endpoint" },
];

const embeddingEngines: QuickOptionChoice[] = [
  { value: "builtin", label: "Built in" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom endpoint" },
];

const rerankers: QuickOptionChoice[] = [
  { value: "current", label: "Current backend" },
  { value: "claude", label: "Claude" },
  { value: "local", label: "Local" },
  { value: "disabled", label: "Disabled" },
];

const allSettings = (): QuickOptionDefinition => ({ id: "all-settings", label: "Open all settings", kind: "action" });
const desktopIntegrations = (): QuickOptionDefinition => ({ id: "desktop-integrations", label: "Desktop integrations", kind: "action" });

const utilityBackend = (state: QuickOptionsState): QuickOptionDefinition => ({
  id: "utility-backend",
  label: "Utility backend",
  kind: "select",
  value: state.utilityBackend,
  choices: utilityBackends,
  ...(state.utilityEndpoint ? { description: state.utilityEndpoint } : {}),
});

const activeProject = (state: QuickOptionsState): QuickOptionDefinition => ({
  id: "active-project",
  label: "Active project",
  kind: "status",
  value: state.activeProject ?? "No project selected",
});

export function quickOptionsFor(page: CompanionPage, state: QuickOptionsState): QuickOptionDefinition[] {
  switch (page) {
    case "chat":
      return [
        { id: "chat-backend", label: "Chat backend", kind: "select", value: state.chatBackend, choices: chatBackends, description: state.chatModel },
        { id: "agent-mode", label: "Agent mode", kind: "toggle", value: state.agentModeEnabled },
        { id: "vault-context", label: "Vault context", kind: "toggle", value: state.vaultContextEnabled },
        { id: "memory-capture", label: "Capture sessions on save", kind: "toggle", value: state.memoryIngestOnSave },
        desktopIntegrations(),
        allSettings(),
      ];
    case "inbox": {
      const clipperLabel = state.clipperStatus === "not-set-up" ? "Set up schemas" : state.clipperStatus === "update-available" ? "Update schemas" : "View schemas";
      const clipperValue = state.clipperStatus === "not-set-up" ? "Not set up" : state.clipperStatus === "update-available" ? "Update available" : "Current";
      return [
        utilityBackend(state),
        { id: "auto-enrich", label: "Auto-enrich new clips", kind: "toggle", value: state.sourceEnrichOnCreate },
        { id: "inbox-folder", label: "Inbox folder", kind: "text", value: state.sourceInboxFolder },
        { id: "source-capture", label: "Source capture", kind: "toggle", value: state.sourceCaptureEnabled },
        { id: "clipper-schemas", label: "Clipper schemas", kind: "status", value: clipperValue, actionLabel: clipperLabel },
        { id: "embedding-health", label: "Embedding health", kind: "status", value: state.embeddingHealth, actionLabel: "Review" },
        desktopIntegrations(),
        allSettings(),
      ];
    }
    case "related":
      return [
        { id: "semantic-search", label: "Semantic search", kind: "toggle", value: state.semanticEnabled },
        { id: "embedding-engine", label: "Embedding engine", kind: "select", value: state.embeddingEngine, choices: embeddingEngines },
        { id: "embedding-model", label: "Embedding model", kind: "status", value: state.embeddingModel },
        { id: "index-health", label: "Index health", kind: "status", value: state.indexHealth },
        { id: "rebuild-index", label: "Build or rebuild index", kind: "action" },
        desktopIntegrations(),
        allSettings(),
      ];
    case "memory":
      return [
        { id: "memory-enabled", label: "Session memory", kind: "toggle", value: state.memoryEnabled },
        { id: "memory-folder", label: "Memory folder", kind: "text", value: state.memoryFolder },
        { id: "memory-capture", label: "Capture sessions on save", kind: "toggle", value: state.memoryIngestOnSave },
        { id: "consolidate-memory", label: state.memoryAutoConsolidate ? "Consolidate memory now" : "Build memory summary", kind: "action" },
        desktopIntegrations(),
        allSettings(),
      ];
    case "research-desk":
      return [
        activeProject(state),
        utilityBackend(state),
        { id: "discovery-enabled", label: "Scholarly discovery", kind: "toggle", value: state.discoveryEnabled },
        { id: "clippings-inbox", label: "Open clippings inbox", kind: "action" },
        desktopIntegrations(),
        allSettings(),
      ];
    case "research-workbench":
      return [
        activeProject(state),
        { id: "research-section", label: "Research section", kind: "status", value: state.activeResearchTab ?? "Overview" },
        utilityBackend(state),
        { id: "discovery-reranker", label: "Discovery reranker", kind: "select", value: state.discoveryReranker, choices: rerankers },
        { id: "discovery-enabled", label: "Scholarly discovery", kind: "toggle", value: state.discoveryEnabled },
        desktopIntegrations(),
        allSettings(),
      ];
  }
}

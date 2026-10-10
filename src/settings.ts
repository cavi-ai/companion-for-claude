import { chatBackendForRuntime, chatBackendOptions } from "./providers/runtimeBackend";
import { DEVICE_MODELS, clearDeviceModel, deviceModelCached } from "./device/models";
import { researchModelOptions } from "./research/researchModel";
import { App, Notice, Platform, PluginSettingTab, Setting, type Plugin, type SettingDefinition, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "./main";
import { CLAUDE_MODELS } from "./claude/models";
import type { ProviderStatus } from "./providers/types";
import { readAnthropicEnv, hasAnthropicEnvCredential } from "./providers/env";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "./mcp/clientConfig";
import { dispatchSetupSteps, repliesSetupSteps } from "./cloud/setup";
import { semanticItems, type SemanticItemsContext } from "./settingsItems/semantic";
import { localModelsItems, type DetectedModels, type LocalModelsItemsContext } from "./settingsItems/localModels";
import { ChoiceModal } from "./view/ChoiceModal";
import { type McpServerConfig, type PluginSettings } from "./types";
import { needsCredentialSetup } from "./providers/setupState";
import { claudeBackend } from "./cli/backends/claude";
import { codexBackend } from "./cli/backends/codex";
import { opencodeBackend } from "./cli/backends/opencode";
import type { CliBackend } from "./cli/backends/types";
import type { CliProvider } from "./providers/cliProvider";

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Text controls hand back a string; anything else is an empty field. */
function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Settings whose stored shape differs from the control's value. */
const CODECS: Record<string, { read(s: PluginSettings): unknown; write(s: PluginSettings, v: unknown): void }> = {};

/** `v.trim()` on the way in, verbatim on the way out. */
function trimmed(key: keyof PluginSettings): void {
  CODECS[key] = {
    read: (s) => s[key],
    write: (s, v) => { (s as unknown as Record<string, unknown>)[key] = asText(v).trim(); },
  };
}

/** `v.trim() || fallback` — an emptied folder/host field returns to its default. */
function trimmedOr(key: keyof PluginSettings, fallback: string): void {
  CODECS[key] = {
    read: (s) => s[key],
    write: (s, v) => { (s as unknown as Record<string, unknown>)[key] = asText(v).trim() || fallback; },
  };
}

/** Comma-separated in the field, string[] in settings. */
function tagList(key: "artifactBaseTags" | "chatBaseTags" | "sourceBaseTags"): void {
  CODECS[key] = {
    read: (s) => s[key].join(", "),
    write: (s, v) => { s[key] = splitTags(asText(v)); },
  };
}

for (const key of [
  "apiKey", "oauthToken", "baseUrl", "customModel", "ollamaUtilityModel", "classifierModel", "openaiCompatHost", "openaiCompatKey",
  "openAlexContactEmail", "zoteroUserId", "zoteroApiKey", "braveSearchApiKey", "cloudRoutineFireUrl",
  "cloudRoutineToken", "cloudReplyRepo", "cloudReplyToken", "mcpToken", "publishGithubToken", "publishApiBase",
] as const) trimmed(key);

for (const [key, fallback] of [
  ["artifactFolder", "Claude/Artifacts"], ["chatFolder", "Claude/Chats"], ["planFolder", "Claude/Plans"],
  ["templatesFolder", "Claude/Templates"], ["memoryFolder", "Claude/Sessions"], ["sourceInboxFolder", "Clippings"],
  ["clipOrganizedFolder", "Library"], ["ontologyFolder", "Ontology"], ["cloudReplyBranch", "main"],
  ["cloudReplyFolder", "Claude/Replies"], ["mcpWriteFolder", "Claude/Inbox"], ["ollamaHost", "http://localhost:11434"],
  ["ollamaModel", "llama3.1"], ["embeddingModel", "nomic-embed-text"],
] as const) trimmedOr(key, fallback);

for (const key of ["artifactBaseTags", "chatBaseTags", "sourceBaseTags"] as const) tagList(key);

for (const key of ["activeNote", "selection", "linkedNotes", "searchVault"] as const) {
  CODECS[`context.${key}`] = {
    read: (s) => s.context[key],
    write: (s, v) => { s.context[key] = v === true; },
  };
}

// ---------- settings diet: basic vs advanced ----------

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

const PAGE_DESC = {
  agent:
    "One agent, three surfaces. In chat: Claude searches, reads, and — with writes on — edits your vault, asking before every write. "
    + "On desktop, Claude Code uses the official Obsidian CLI by default; the optional bridge serves Claude Desktop and advanced live-vault clients. "
    + "On mobile, a Cloud session works your vault's Git repo and writes replies back.",
  mcpBridge: "Optional advanced bridge for Claude Desktop and live-vault API clients. Claude Code uses the official Obsidian CLI by default and does not need this server. Bound to 127.0.0.1 and protected by a token.",
  mcpClient:
    "Let the in-chat agent use tools from external MCP servers — Companion can serve its vault through the optional desktop bridge and consume other servers here. "
    + "Every external tool call asks for your confirmation. HTTP servers work on mobile; stdio commands run on desktop only.",
  cloudDispatch:
    "Dispatch a Claude Code session in the cloud to work your vault's Git repo and report back — so you can cowork with Claude from a phone, where the local bridge can't run. "
    + "In the Claude Code web UI, create a routine pointed at your vault's Git repo, then complete the checklist.",
  cloudReplies:
    "Pull notes a cloud session wrote back into your vault's GitHub repo — over HTTPS, so it works on a phone with no local git. "
    + "Point this at the repo, branch, and folder the session writes replies to.",
  localModels: "Run cheap, bulk work — summarizing, tagging, ingestion — on a local model to save Anthropic tokens. Chat and plans still use Claude unless you route them here.",
  openaiCompat: "Point at LM Studio, mlx-lm, vLLM, Jan, or Ollama's /v1 mode — including Apple-silicon-optimized servers like `mlx_lm.server`. Select it as the chat backend or utility backend above, and as an embedding engine under Semantic search.",
  sourceCapture: "Point the Obsidian Web Clipper (and dropped CSVs) at an inbox folder; Companion types each new file into a schema-validated source note. Extraction uses your utility model (local if enabled).",
  discovery: "Discover searches OpenAlex for works and citation links, fills DOI metadata from Crossref and preprint metadata from arXiv, and imports Zotero items by key. Requests run only when you press Search, Expand, or Import.",
  publishing:
    "Publish a note or an artifact as a secret GitHub Gist: anyone with the link can read it and nobody else can find it. "
    + "Needs a fine-grained token with account permission Gists: read and write. Requests run only when you publish, unpublish, or test the token.",
  memory: "Capture Claude Code CLI sessions for this vault into sanitized digest notes. Desktop-only; sessions are matched by the directory you ran Claude Code in.",
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
function applyTiers(items: SettingDefinitionItem[], showAdvanced: () => boolean, settings: PluginSettings): SettingDefinitionItem[] {
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

/** The plugin capabilities the settings tab and its page builders use; Obsidian's base class needs the Plugin itself. */
export type SettingsHost = Plugin & SemanticItemsContext["plugin"] & LocalModelsItemsContext["plugin"] & Pick<
  ClaudeCompanionPlugin,
  | "clearDiscoveryCache" | "clipperTemplatesStale" | "deviceChat" | "exportClipperTemplates" | "externalMcp" | "invalidateIndexer" | "loadOntologyOnStart"
  | "mcpRunning" | "offerOntologySeed" | "ontology" | "openDesktopIntegrations" | "publishedItems" | "rebuildSemanticIndex" | "refreshViews" | "router"
  | "runFirstRunPrompts" | "saveSettings" | "secrets" | "secretsWriteFailures" | "settings" | "testCloudReplies" | "testPublishToken" | "unpublishItem"
>;

export class ClaudeCompanionSettingTab extends PluginSettingTab {
  /** Models from the last Detect (Ollama; the OpenAI-compatible endpoint such as LM Studio, mlx-lm, vLLM, Jan), for the dropdowns. */
  private detectedModels: DetectedModels = { ollama: null, endpoint: null };
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  private revealMcpToken = false;

  constructor(
    app: App,
    private plugin: SettingsHost,
  ) {
    super(app, plugin);
  }

  /** Where credentials actually land, so the copy can't claim safety it doesn't have. */
  private storageBlurb(): string {
    return this.secretStorageWorking()
      ? "Stored in your device's secret storage, not in this vault."
      : "Stored locally in this vault's plugin data.";
  }

  /** The API being present is not proof the backend took the write. */
  private secretStorageWorking(): boolean {
    return this.plugin.secrets().available() && this.plugin.secretsWriteFailures().length === 0;
  }

  override getControlValue(key: string): unknown {
    const codec = CODECS[key];
    const s = this.plugin.settings;
    if (key === "chatBackend") return chatBackendForRuntime(s.chatBackend, Platform.isMobile);
    return codec ? codec.read(s) : (s as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    const codec = CODECS[key];
    if (codec) codec.write(s, value);
    else (s as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
    await this.afterChange(key);
  }

  /** Per-key follow-up the old onChange handlers did after saving. */
  private async afterChange(key: string): Promise<void> {
    switch (key) {
      case "model":
      case "customModel":
      case "chatBackend":
      case "researchModel":
      case "openaiCompatModel":
        if (key === "chatBackend") {
          const backend = this.plugin.settings.chatBackend;
          const cli = backend === "claude-cli" ? this.plugin.router().claudeCli : backend === "codex-cli" ? this.plugin.router().codexCli : backend === "opencode-cli" ? this.plugin.router().opencodeCli : null;
          if (cli) void cli.refresh().then(() => this.plugin.refreshViews());
        }
        this.plugin.refreshViews();
        return;
      case "semanticIndexPdfs":
        this.plugin.invalidateIndexer();
        return;
      case "openaiCompatEmbeddingModel":
        this.plugin.invalidateIndexer();
        return;
      case "ontologyFolder":
        await this.plugin.ontology()?.load();
        return;
      case "ontologyEnabled":
        // Turning it on here is an explicit ask, so the seed offer follows
        // regardless of credential — the gate is a startup ordering rule.
        if (this.plugin.settings.ontologyEnabled) {
          await this.plugin.loadOntologyOnStart();
          void this.plugin.offerOntologySeed();
        }
        return;
      case "sourceEnrichOnCreate":
        // Re-enabling is explicit consent to send inbox files to the utility model.
        if (this.plugin.settings.sourceEnrichOnCreate) {
          this.plugin.settings.sourceCaptureConsent = "allow";
          await this.plugin.saveSettings();
        }
        return;
      // Rows below gate the visibility of other rows, or feed a checklist.
      case "authMode":
      case "semanticEnabled":
      case "webSearchEnabled":
      case "webSearchEngine":
      case "cloudDispatchEnabled":
      case "cloudRoutineFireUrl":
      case "cloudRoutineToken":
      case "cloudReplyRepo":
      case "cloudReplyBranch":
      case "cloudReplyFolder":
      case "cloudReplyToken":
        this.update();
        return;
      default:
        return;
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return applyTiers(this.rawSettingDefinitions(), () => this.plugin.settings.settingsShowAdvanced, this.plugin.settings);
  }

  private rawSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: "group", items: this.introItems() },
      { type: "group", heading: "Connection", items: this.connectionItems() },
      { type: "group", heading: "Behavior", items: this.behaviorItems() },
      {
        type: "group",
        heading: "Agent",
        items: [
          { type: "page", name: "Agent (act on your vault)", desc: PAGE_DESC.agent, items: this.agentItems() },
          { type: "page", name: "Agent bridge — MCP server (desktop)", visible: () => !Platform.isMobile, desc: PAGE_DESC.mcpBridge, items: this.mcpItems() },
          { type: "page", name: "External tools — MCP client", desc: PAGE_DESC.mcpClient, items: this.mcpClientItems() },
          { type: "page", name: "Cloud (experimental)", desc: this.cloudDesc(), items: [...this.cloudItems(), ...this.repliesItems()] },
          { type: "page", name: "Publishing", desc: PAGE_DESC.publishing, items: this.publishItems() },
        ],
      },
      {
        type: "group",
        heading: "Vault intelligence",
        items: [
          { type: "page", name: "Semantic search (local embeddings)", items: this.semanticItems() },
          { type: "page", name: "Local models (Ollama & endpoints)", desc: `${PAGE_DESC.localModels} ${PAGE_DESC.openaiCompat}`, items: this.localModelsItems() },
          { type: "page", name: "Source capture (typed clips)", desc: PAGE_DESC.sourceCapture, items: this.sourceCaptureItems() },
          { type: "page", name: "Vault ontology (typed notes & relations)", items: this.ontologyItems() },
          { type: "page", name: "Research Desk & discovery", desc: PAGE_DESC.discovery, items: this.discoveryItems() },
        ],
      },
      {
        type: "group",
        heading: "Files, memory & privacy",
        items: [
          { type: "page", name: "Session memory", visible: () => !Platform.isMobile, desc: PAGE_DESC.memory, items: this.memoryItems() },
          { type: "page", name: "Files & tags", items: [...this.storageItems(), ...this.indexingItems()] },
          { type: "page", name: "What this plugin accesses (privacy)", items: this.privacyItems() },
          { type: "page", name: "Desktop-only features", visible: () => Platform.isMobile, items: this.desktopOnlyItems() },
        ],
      },
    ];
  }

  private cloudDesc(): string {
    return `${PAGE_DESC.cloudDispatch} ⚠️ Unlike the local bridge, this sends your prompt + attached note context to Anthropic's cloud and runs against your vault's Git repo. ${this.storageBlurb()} Use a private repo. ${PAGE_DESC.cloudReplies}`;
  }

  /** Callouts, the advanced-settings reveal, and the desktop-integrations entry point, above the first heading. */
  private introItems(): SettingGroupItem[] {
    return [
      {
        name: "Show advanced settings",
        desc: "Basic settings are what a first-week user touches. Turn this on to see everything.",
        control: { type: "toggle", key: "settingsShowAdvanced" },
      },
      {
        name: "Credentials are stored in this vault",
        // Credentials fall back to this vault's data.json two ways: no secret-store
        // API, or a backend that refused the write. Both ride vault sync.
        visible: () => !this.secretStorageWorking(),
        render: (setting) => {
          const unsupported = !this.plugin.secrets().available();
          const warn = setting.settingEl.createDiv({ cls: "cc-connect-callout" });
          const p = warn.createEl("p");
          p.appendText(
            unsupported
              ? "This version of Obsidian has no encrypted secret storage, so keys and tokens are written to this vault’s "
                + "data.json — if the vault syncs to iCloud, Dropbox, or git, they sync with it. "
                + "Update Obsidian and Companion will move them into your device’s keychain automatically."
              : "Your device’s secret storage did not accept the write, so keys and tokens remain in this vault’s "
                + "data.json — if the vault syncs to iCloud, Dropbox, or git, they sync with it. "
                + "Companion keeps them there rather than losing them, and moves them across as soon as the store works.",
          );
          if (Platform.isLinux) {
            p.appendText(" On Linux that needs kwallet, kwallet5, kwallet6, or gnome-libsecret installed.");
          }
        },
      },
      {
        name: "Step 1 — connect to Claude",
        // The one mandatory step, called out while it's missing.
        visible: () => {
          const router = this.plugin.router();
          return needsCredentialSetup({
            backend: router.chatBackend,
            hasAnthropicCredential: router.anthropic.hasCredentials(),
            hasClaudeCli: router.claudeCli.hasCredentials(),
            hasCodexCli: router.codexCli.hasCredentials(),
            hasOpencodeCli: router.opencodeCli.hasCredentials(),
          });
        },
        render: (setting) => {
          const callout = setting.settingEl.createDiv({ cls: "cc-connect-callout" });
          const p = callout.createEl("p");
          const backend = chatBackendForRuntime(this.plugin.settings.chatBackend, Platform.isMobile);
          const cliBackends: Record<string, CliBackend> = { "claude-cli": claudeBackend, "codex-cli": codexBackend, "opencode-cli": opencodeBackend };
          const cli = cliBackends[backend];
          if (cli) {
            p.appendText(`${cli.label} is not signed in on this computer. ${capitalize(cli.signInHint)} in a terminal, or add an Anthropic API key below. `);
          } else {
            p.appendText("Add an Anthropic API key below to start chatting. Create one at ");
            p.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
          }
          p.appendText(` — ${this.storageBlurb().replace(/^S/, "s")}`);
        },
      },
      {
        name: "Desktop integrations",
        visible: () => !Platform.isMobile,
        desc: "Install the CAVI marketplace plugin and merge the Claude Desktop config.",
        aliases: ["marketplace", "claude desktop", "obsidian-agent"],
        render: (setting) => {
          setting.addButton((btn) => btn.setButtonText("Set up").onClick(() => this.plugin.openDesktopIntegrations()));
        },
      },
    ];
  }

  /** Status row + "Check <label>" button for one CLI backend, shared by Claude Code, Codex, and OpenCode. */
  private cliStatusItems(backend: CliBackend, cliOf: (router: ReturnType<ClaudeCompanionPlugin["router"]>) => CliProvider): SettingGroupItem[] {
    return [
      {
        name: backend.label,
        desc: `Status of the ${backend.binary} command this backend runs. Companion never sees your credentials; ${backend.label} holds them.`,
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          const cli = cliOf(this.plugin.router());
          const probe = cli.probe();
          if (probe) this.renderStatus(status, { ok: probe.loggedIn, detail: probe.loggedIn ? `${backend.label} ${probe.version} · signed in via ${probe.method} · ${probe.executable}` : `Not signed in — ${backend.signInHint}.` });
          setting.addButton((btn) =>
            btn
              .setButtonText(`Check ${backend.label}`)
              .onClick(async () => {
                this.renderStatus(status, { ok: true, detail: "Checking…" });
                const result = await cliOf(this.plugin.router()).test();
                this.renderStatus(status, result);
                this.plugin.refreshViews();
                if (result.ok) await this.plugin.runFirstRunPrompts();
              }),
          );
        },
      },
    ];
  }

  private connectionItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: "Authentication",
        desc: "How Companion for Claude authenticates to Anthropic. API key is the standard, store-safe option.",
        control: {
          type: "dropdown",
          key: "authMode",
          options: {
            apiKey: "API key (recommended)",
            oauthToken: "Long-term OAuth token (subscription)",
            environment: "Import from environment",
          },
        },
      },
      {
        name: "Anthropic API key",
        aliases: ["credential", "anthropic", "sk-ant"],
        visible: () => this.plugin.settings.authMode === "apiKey",
        render: (setting) => {
          setting.setDesc(
            createFragment((frag) => {
              frag.appendText("Bring your own key from ");
              frag.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
              frag.appendText(`. ${this.storageBlurb()}`);
            }),
          );
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setCssStyles({ width: "320px" });
            text
              .setPlaceholder("sk-ant-api…")
              .setValue(s.apiKey)
              .onChange(async (v) => {
                s.apiKey = v.trim();
                await this.plugin.saveSettings();
              });
          });
        },
      },
      {
        name: "OAuth token",
        aliases: ["subscription", "setup-token", "sk-ant-oat"],
        visible: () => this.plugin.settings.authMode === "oauthToken",
        render: (setting) => {
          setting.setDesc(
            "Paste a long-term token from `claude setup-token` (starts with sk-ant-oat). Requests authenticate as your Claude subscription, "
              + `so usage draws on your plan's limits rather than pay-as-you-go API credit. ${this.storageBlurb()} Sent as a bearer token.`,
          );
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setCssStyles({ width: "320px" });
            text
              .setPlaceholder("sk-ant-oat…")
              .setValue(s.oauthToken)
              .onChange(async (v) => {
                s.oauthToken = v.trim();
                await this.plugin.saveSettings();
              });
          });
        },
      },
      {
        name: "Environment credential",
        aliases: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
        visible: () => this.plugin.settings.authMode === "environment",
        render: (setting) => {
          const env = readAnthropicEnv();
          const found = hasAnthropicEnvCredential(env);
          const detail = found
            ? `Using ${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"}` + (env.ANTHROPIC_BASE_URL ? " + ANTHROPIC_BASE_URL" : "") + " from the environment."
            : "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found in this process's environment. Note: apps launched from the macOS Dock often don't inherit shell exports — launch Obsidian from a terminal, or use one of the other modes.";
          const box = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          box.toggleClass("is-ok", found);
          box.toggleClass("is-err", !found);
          box.setText((found ? "✓ " : "✗ ") + detail);
        },
      },
      {
        name: "API base URL",
        desc: "Optional. Point at a gateway/proxy instead of api.anthropic.com. Leave blank for the default.",
        control: { type: "text", key: "baseUrl", placeholder: "https://api.anthropic.com" },
      },
      {
        name: "Save & test connection",
        desc: "Saves settings and sends a tiny request to verify your credential.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          setting.addButton((btn) =>
            btn
              .setButtonText("Save & test")
              .setCta()
              .onClick(async () => {
                await this.plugin.saveSettings();
                this.renderStatus(status, { ok: true, detail: "Testing…" });
                const result = await this.plugin.router().anthropic.test();
                this.renderStatus(status, result);
                // Prompts held back while there was no credential can run now.
                if (result.ok) await this.plugin.runFirstRunPrompts();
              }),
          );
        },
      },
      {
        name: "Model",
        desc: "Pick a default model. A custom id below overrides this.",
        control: {
          type: "dropdown",
          key: "model",
          options: Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, m.label])),
        },
      },
      {
        name: "Custom model id",
        desc: "Optional. Overrides the dropdown — useful for new or dated model snapshots.",
        control: { type: "text", key: "customModel", placeholder: "e.g. claude-sonnet-4-6-20250930" },
      },
      {
        name: "Chat backend",
        desc: "On-device GPU runs text chat inside Obsidian with a downloaded model. It requires WebGPU and float16 support in this app. Auto starts with Claude and can fall back to a reachable endpoint. CLI backends run on desktop.",
        control: {
          type: "dropdown",
          key: "chatBackend",
          options: chatBackendOptions(Platform.isMobile),
        },
      },
      {
        name: "On-device model",
        desc: "SmolLM2 is the smaller default; Qwen3 is a larger alternative for broader chat tasks. Download sizes exclude runtime files and are smaller than peak memory use. Text only; agent tools are unavailable. Context is limited to 2048 input tokens and replies to 256 tokens.",
        visible: () => this.plugin.settings.chatBackend === "device",
        control: { type: "dropdown", key: "deviceChatModel", options: Object.fromEntries(DEVICE_MODELS.map((m) => [m.id, m.label])) },
      },
      {
        name: "On-device model download",
        desc: "One explicit download from Hugging Face and the ONNX runtime CDN, cached on this device. Missing files require another explicit download. On-device chat text stays in Obsidian; utility task routing is separate. Loading pauses mobile embeddings to reduce memory use. No model loads when Obsidian starts.",
        visible: () => this.plugin.settings.chatBackend === "device",
        render: (setting) => {
          const status = setting.descEl.createDiv();
          const storage = typeof caches === "undefined" ? undefined : caches;
          const id = this.plugin.settings.deviceChatModel;
          void deviceModelCached(id, storage).then((ready) => status.setText(ready ? "Downloaded on this device." : "Model not downloaded on this device."));
          let abort: AbortController | undefined;
          setting.addButton((button) => button.setButtonText("Download model").setCta().onClick(async () => {
            if (abort) return;
            abort = new AbortController();
            button.setDisabled(true);
            status.setText("Checking GPU support inside Obsidian…");
            try {
              const support = await this.plugin.router().device.test();
              if (abort.signal.aborted) return;
              if (!support.ok) throw new Error(support.detail);
              status.setText("Downloading and preparing model…");
              await this.plugin.deviceChat().download(id, (percent) => status.setText(`Downloading model · ${percent}%`), abort.signal);
              status.setText("Downloaded. Open Companion chat to use this model.");
            } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
            finally { abort = undefined; button.setDisabled(false); }
          }));
          setting.addButton((button) => button.setButtonText("Stop").onClick(() => { abort?.abort(); this.plugin.deviceChat().cancel(); status.setText("On-device request stopped."); }));
          setting.addButton((button) => button.setButtonText("Delete model").onClick(async () => {
            if (this.plugin.deviceChat().busy() || abort) { new Notice("Stop the on-device request before deleting its model."); return; }
            try { await clearDeviceModel(id, storage); status.setText("Model removed from this device."); }
            catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
          }));
        },
      },
      ...(Platform.isMobile ? [] : this.cliStatusItems(claudeBackend, (r) => r.claudeCli)),
      ...(Platform.isMobile ? [] : this.cliStatusItems(codexBackend, (r) => r.codexCli)),
      {
        name: "Codex model",
        visible: () => !Platform.isMobile,
        desc: "Optional model id passed as -m to codex exec. Leave blank to use Codex's own default.",
        control: { type: "text", key: "codexModel", placeholder: "e.g. gpt-5.1-codex" },
      },
      ...(Platform.isMobile ? [] : this.cliStatusItems(opencodeBackend, (r) => r.opencodeCli)),
      {
        name: "OpenCode model",
        visible: () => !Platform.isMobile,
        desc: "Optional model id passed as -m to opencode run (e.g. anthropic/claude-sonnet-5). Leave blank to use OpenCode's own default.",
        control: { type: "text", key: "opencodeModel", placeholder: "e.g. anthropic/claude-sonnet-5" },
      },
      {
        name: "Max response tokens",
        desc: "Upper bound on a single reply (cap 64000). Higher values leave less context-window room.",
        control: { type: "number", key: "maxTokens", min: 1, max: 64000, step: 1 },
      },
    ];
  }

  private behaviorItems(): SettingGroupItem[] {
    return [
      {
        name: "System prompt",
        desc: "Prepended to every conversation. The artifact design system is always appended automatically.",
        control: { type: "textarea", key: "systemPrompt", rows: 5 },
      },
      {
        name: "Context character budget",
        desc: "Max characters of vault context attached to a request.",
        control: { type: "number", key: "contextCharBudget", min: 1, step: 1 },
      },
      {
        name: "Max context notes",
        desc: "How many linked / search-matched notes to include.",
        control: { type: "number", key: "maxContextNotes", min: 0, step: 1 },
      },
      {
        name: "New chat context: active note",
        desc: "Each new chat starts with the active note attached. @mentions and the context menu change only that chat.",
        control: { type: "toggle", key: "context.activeNote" },
      },
      {
        name: "New chat context: selection",
        desc: "Each new chat starts with your highlighted text attached.",
        control: { type: "toggle", key: "context.selection" },
      },
      {
        name: "New chat context: linked notes",
        desc: "Each new chat starts with notes linked to and from the active note.",
        control: { type: "toggle", key: "context.linkedNotes" },
      },
      {
        name: "New chat context: vault search",
        desc: "Each new chat starts with keyword or semantic vault search on (off in agent mode, where Claude searches with tools).",
        control: { type: "toggle", key: "context.searchVault" },
      },
    ];
  }

  private storageItems(): SettingGroupItem[] {
    return [
      {
        name: "Open artifacts in",
        desc: "Where the “Open” button on an artifact sends it. Keeping it in Obsidian is tidiest; choose a browser to pop it out.",
        // Shelling out to a browser needs a desktop runtime.
        visible: () => !Platform.isMobile,
        control: {
          type: "dropdown",
          key: "artifactOpenTarget",
          options: {
            obsidian: "Obsidian (in-app, full screen)",
            default: "System default browser",
            chrome: "Google Chrome",
            safari: "Safari",
            brave: "Brave",
            firefox: "Firefox",
          },
        },
      },
      { name: "Artifacts folder", desc: "Where saved artifacts (interactive HTML notes) are written.", control: { type: "text", key: "artifactFolder", placeholder: "Claude/Artifacts" } },
      { name: "Chats folder", desc: "Where saved chat transcripts are written.", control: { type: "text", key: "chatFolder", placeholder: "Claude/Chats" } },
      { name: "Plans folder", desc: "Where saved plan notes (artifact + Build-task checklist) are written.", control: { type: "text", key: "planFolder", placeholder: "Claude/Plans" } },
      { name: "Templates folder", desc: "Markdown notes here become your own slash commands in chat (frontmatter: name, description, optional model/context).", control: { type: "text", key: "templatesFolder", placeholder: "Claude/Templates" } },
      { name: "Conversation history limit", desc: "How many past chats to keep (oldest are pruned). Use 0 for unlimited.", control: { type: "number", key: "maxConversations", min: 0, step: 1 } },
    ];
  }

  private indexingItems(): SettingGroupItem[] {
    return [
      { name: "Auto-tag on save", desc: "When saving an artifact or chat, generate topic tags + a one-line summary (uses the utility provider) so notes are indexed correctly.", control: { type: "toggle", key: "autoTagOnSave" } },
      { name: "Artifact base tags", desc: "Comma-separated tags every saved artifact gets (for reliable filtering).", control: { type: "text", key: "artifactBaseTags" } },
      { name: "Chat base tags", desc: "Comma-separated tags every saved chat gets.", control: { type: "text", key: "chatBaseTags" } },
    ];
  }

  private memoryItems(): SettingGroupItem[] {
    return [
      { name: "Enable session memory", desc: "Show the capture command, the “ingest” checkbox, and the memory sidebar.", control: { type: "toggle", key: "memoryEnabled" } },
      { name: "Memory folder", desc: "Where session digest notes are written.", control: { type: "text", key: "memoryFolder", placeholder: "Claude/Sessions" } },
      { name: "Ingest on save (default)", desc: "Default state of the “ingest” checkbox next to Save in the chat view.", control: { type: "toggle", key: "memoryIngestOnSave" } },
      { name: "Auto-consolidate memory", desc: "After each capture, merge recent digests into the “What Claude Knows” note (uses the utility model — local when enabled).", control: { type: "toggle", key: "memoryAutoConsolidate" } },
    ];
  }

  private ontologyItems(): SettingGroupItem[] {
    return [
      { name: "Enable ontology", desc: "Claude writes typed frontmatter and wikilink relations that conform to schema notes in your vault. Run “Seed ontology” to create the default schemas.", control: { type: "toggle", key: "ontologyEnabled" } },
      { name: "Ontology folder", desc: "Where the schema notes live (one note per type). Edit those notes to change the schema.", control: { type: "text", key: "ontologyFolder", placeholder: "Ontology" } },
    ];
  }

  private privacyItems(): SettingGroupItem[] {
    return [
      {
        name: "What this plugin accesses",
        aliases: ["privacy", "network", "telemetry"],
        desc:
          "Your messages and vault context go only to Anthropic (and your local Ollama or OpenAI-compatible endpoint, if enabled). "
          + "The built-in semantic-search engine downloads its model once from huggingface.co and cdn.jsdelivr.net when you click Download; afterwards it runs fully offline. "
          + "On desktop, optional features touch files outside the vault: session capture reads Claude Code transcripts from your Claude projects folder, and “open artifact in browser” writes a temporary HTML file. "
          + "Semantic search reads every note in your vault to build a local index. Copy buttons use the system clipboard. All filesystem access is disabled on mobile.",
      },
    ];
  }

  private desktopOnlyItems(): SettingGroupItem[] {
    return [
      {
        name: "Available on a computer",
        desc: "These need a desktop runtime and are available when you open this vault on a computer: local models (Ollama & endpoints), the Claude Desktop / advanced MCP bridge, and session capture (browsing captured memory works on mobile).",
      },
    ];
  }

  private agentItems(): SettingGroupItem[] {
    return [
      { name: "Let Claude use vault tools", desc: "Claude can search and read your notes on its own while answering (read-only). Turn off for plain chat with pre-attached context.", control: { type: "toggle", key: "agentModeEnabled" } },
      { name: "Allow write tools", desc: "Also let Claude create, edit, and move notes from chat. Every write asks for your confirmation first.", control: { type: "toggle", key: "agentAllowWrites" } },
      { name: "Standing orders", desc: "Run prompt templates that have a schedule or on_note trigger while Obsidian is open.", control: { type: "toggle", key: "standingOrdersEnabled" } },
      { name: "Notify when a turn finishes in the background", desc: "Show a system notice and a status-bar item if a turn completes while its chat pane is closed.", control: { type: "toggle", key: "notifyOnTurnComplete" } },
      { name: "Review edits in the editor", desc: "When the note is open, show proposed changes inline with word-level highlights and per-change Accept/Reject instead of a dialog.", control: { type: "toggle", key: "inlineDiffEnabled" } },
      { name: "Rewrite button on selection", desc: "Show a small “Rewrite with Claude” action above selected text. Desktop only.", control: { type: "toggle", key: "selectionActionEnabled" } },
      { name: "Max tool iterations per turn", desc: "How many search/read/write rounds Claude may take before it must answer. When the cap stops a turn, a Continue button resumes it.", control: { type: "slider", key: "agentMaxIterations", min: 1, max: 50, step: 1 } },
      { name: "Auto-continue capped turns", desc: "When a turn hits the iteration cap, keep going automatically (up to 4 chained continuations) instead of waiting for you to press Continue.", control: { type: "toggle", key: "agentAutoContinue" } },
      { name: "Web search tool", desc: "Let Claude search the public web from chat (explicit searches only — nothing fires in the background).", control: { type: "toggle", key: "webSearchEnabled" } },
      {
        name: "Search engine",
        desc: "DuckDuckGo needs no key; Brave gives higher-quality results with an API key.",
        visible: () => this.plugin.settings.webSearchEnabled,
        control: { type: "dropdown", key: "webSearchEngine", options: { duckduckgo: "DuckDuckGo (no key)", brave: "Brave Search (API key)" } },
      },
      {
        name: "Brave Search API key",
        visible: () => this.plugin.settings.webSearchEnabled && this.plugin.settings.webSearchEngine === "brave",
        render: (setting) => {
          setting.setDesc(`Subscription token from brave.com/search/api. ${this.storageBlurb()}`);
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.settings.braveSearchApiKey).onChange(async (v) => {
              this.plugin.settings.braveSearchApiKey = v.trim();
              await this.plugin.saveSettings();
            });
          });
        },
      },
      { name: "Web fetch tool", desc: "Let Claude read a public web page as clean markdown — after a search, or a URL you give it.", control: { type: "toggle", key: "webFetchEnabled" } },
    ];
  }

  private sourceCaptureItems(): SettingGroupItem[] {
    return [
      { name: "Enable source capture", desc: "Master switch for watching the inbox and the “Enrich note as source” command.", control: { type: "toggle", key: "sourceCaptureEnabled" } },
      { name: "Auto-enrich on create", desc: "Type files automatically as they appear in the inbox (otherwise use the command).", control: { type: "toggle", key: "sourceEnrichOnCreate" } },
      { name: "Inbox folder", desc: "Folder the Web Clipper writes to and Companion watches.", control: { type: "text", key: "sourceInboxFolder", placeholder: "Clippings" } },
      { name: "Organized folder", desc: "Where “Organize clippings” moves reviewed clips — one subfolder per inferred topic/project.", control: { type: "text", key: "clipOrganizedFolder", placeholder: "Library" } },
      { name: "Base tags", desc: "Comma-separated tags added to every enriched source note.", control: { type: "text", key: "sourceBaseTags" } },
      {
        name: "Web Clipper templates",
        desc: "Write clipper templates matching these schemas into the vault. Import them in the Web Clipper extension and clips arrive already typed — enrichment then only fills what the page couldn't say.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
          if (this.plugin.settings.clipperTemplateFingerprint !== "") {
            const stale = this.plugin.clipperTemplatesStale();
            status.setText(stale ? "✗ Templates out of date — schemas or inbox changed since export." : "✓ Templates current with your schemas.");
            status.toggleClass("is-err", stale);
            status.toggleClass("is-ok", !stale);
          }
          setting.addButton((b) =>
            b.setButtonText("Export templates").onClick(async () => {
              await this.plugin.exportClipperTemplates();
              status.setText("✓ Templates current with your schemas.");
              status.toggleClass("is-err", false);
              status.toggleClass("is-ok", true);
            }),
          );
        },
      },
    ];
  }

  private researchModelOptions(): Record<string, string> {
    const router = this.plugin.router();
    const chat = router.chatProvider();
    return researchModelOptions({ providerLabel: router.providerLabel(chat.provider), modelId: chat.model }, { modelId: this.plugin.settings.ollamaModel });
  }

  private discoveryItems(): SettingGroupItem[] {
    return [
      {
        name: "Research model",
        desc: "Runs only when you click a research action: drafting project questions and claim wording, proposing evidence passages, interpreting evidence, drafting and revising sections, the Intelligence briefing, and reranking Discover results.",
        control: { type: "dropdown", key: "researchModel", options: this.researchModelOptions() },
      },
      { name: "Enable scholarly discovery", desc: "Show explicit search, citation expansion, and reranking actions in research projects.", control: { type: "toggle", key: "discoveryEnabled" } },
      { name: "OpenAlex contact email", desc: "Optional. Included as a trimmed mailto parameter in OpenAlex requests.", control: { type: "text", key: "openAlexContactEmail" } },
      { name: "Zotero user id", desc: "Optional. Numeric user id from zotero.org/settings/keys — lets research_source_import resolve a zotero_key into full metadata. Requests fire only on an explicit import.", control: { type: "text", key: "zoteroUserId" } },
      {
        name: "Zotero API key",
        desc: "Optional. Required for private libraries; a public library resolves without one.",
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.settings.zoteroApiKey).onChange(async (value) => {
              this.plugin.settings.zoteroApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          });
        },
      },
      {
        name: "Clear discovery cache",
        desc: "Deletes derived discovery state only. It does not write to or delete vault notes.",
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Clear cache").onClick(() => {
              this.plugin.clearDiscoveryCache();
              new Notice("Discovery cache cleared.");
            }),
          );
        },
      },
    ];
  }

  private localModelsItems(): SettingGroupItem[] {
    return localModelsItems({
      plugin: this.plugin,
      detected: this.detectedModels,
      update: () => this.update(),
      renderStatus: (el, status) => this.renderStatus(el, status),
    });
  }

  private semanticItems(): SettingGroupItem[] {
    return semanticItems({ plugin: this.plugin, update: () => this.update(), offerIndexRebuild: (label) => this.offerIndexRebuild(label) });
  }

  private mcpClientItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const items: SettingGroupItem[] = [];
    s.mcpClientServers.forEach((server, index) => {
      items.push({
        name: server.name.trim() || `Server ${index + 1}`,
        desc: `${server.transport === "http" ? "HTTP" : "stdio (desktop)"}${server.enabled ? "" : " · disabled"}`,
        aliases: ["mcp", "external tools"],
        render: (setting) => {
          const box = setting.settingEl.createDiv({ cls: "cc-mcp-server" });
          setting
            .addToggle((t) =>
              t.setValue(server.enabled).onChange(async (v) => {
                server.enabled = v;
                await this.plugin.saveSettings();
                this.update();
              }),
            )
            .addButton((b) =>
              b.setButtonText("Remove").onClick(async () => {
                s.mcpClientServers.splice(index, 1);
                await this.plugin.saveSettings();
                this.update();
              }),
            );

          new Setting(box).setName("Name").addText((text) =>
            text.setValue(server.name).onChange(async (v) => {
              server.name = v;
              await this.plugin.saveSettings();
            }),
          );

          new Setting(box).setName("Transport").addDropdown((dd) => {
            dd.addOption("http", "HTTP (streamable)");
            dd.addOption("stdio", "stdio command (desktop)");
            dd.setValue(server.transport).onChange(async (v) => {
              server.transport = v as McpServerConfig["transport"];
              await this.plugin.saveSettings();
              this.update();
            });
          });

          if (server.transport === "http") {
            new Setting(box).setName("Server URL").addText((text) => {
              text.inputEl.setCssStyles({ width: "320px" });
              text.setPlaceholder("https://example.test/mcp").setValue(server.url).onChange(async (v) => {
                server.url = v.trim();
                await this.plugin.saveSettings();
              });
            });
          } else {
            new Setting(box).setName("Command").addText((text) => {
              text.inputEl.setCssStyles({ width: "240px" });
              text.setPlaceholder("npx").setValue(server.command).onChange(async (v) => {
                server.command = v.trim();
                await this.plugin.saveSettings();
              });
            });
            new Setting(box).setName("Arguments").addText((text) => {
              text.inputEl.setCssStyles({ width: "320px" });
              text.setPlaceholder("-y @modelcontextprotocol/server-filesystem /path").setValue(server.args).onChange(async (v) => {
                server.args = v;
                await this.plugin.saveSettings();
              });
            });
          }

          const status = box.createDiv({ cls: "cc-conn-status" });
          const error = this.plugin.externalMcp().errorFor(server.name.trim());
          if (error) {
            status.addClass("is-err");
            status.setText(`✗ ${error}`);
          }
          new Setting(box)
            .setName("Test connection")
            .setDesc("Connect now and count the exposed tools.")
            .addButton((button) =>
              button.setButtonText("Test").onClick(async () => {
                button.setDisabled(true);
                status.removeClass("is-ok");
                status.removeClass("is-err");
                status.setText("Connecting…");
                const result = await this.plugin.externalMcp().test(server);
                status.addClass(result.ok ? "is-ok" : "is-err");
                status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
                button.setDisabled(false);
              }),
            );
        },
      });
    });
    items.push({
      name: "Add server",
      desc: "Register another MCP server for the in-chat agent.",
      render: (setting) => {
        setting.addButton((b) =>
          b.setButtonText("Add MCP server").setCta().onClick(async () => {
            s.mcpClientServers.push({ name: "", enabled: true, transport: "http", url: "", command: "", args: "" });
            await this.plugin.saveSettings();
            this.update();
          }),
        );
      },
    });
    return items;
  }

  private cloudItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const dispatchOn = (): boolean => s.cloudDispatchEnabled;
    return [
      {
        name: "Cloud dispatch setup",
        aliases: ["checklist", "routine"],
        render: (setting) => {
          const el = setting.settingEl.createDiv({ cls: "cc-setup-checklist" });
          const steps = dispatchSetupSteps({ fireUrl: s.cloudRoutineFireUrl, token: s.cloudRoutineToken });
          for (const item of steps) {
            const row = el.createDiv({ cls: `cc-setup-step ${item.ok ? "is-ok" : "is-err"}` });
            row.createSpan({ cls: "cc-setup-mark", text: item.ok ? "✓" : "✗" });
            row.createSpan({ text: item.detail && !item.ok ? `${item.label} — ${item.detail}` : item.label });
          }
          if (steps.every((item) => item.ok)) {
            el.createDiv({ cls: "cc-setup-step is-ok", text: "✓ Ready — run “Send to cloud Claude session” from the command palette." });
          }
        },
      },
      { name: "Enable cloud dispatch", desc: "Adds a “Send to cloud Claude session” command.", control: { type: "toggle", key: "cloudDispatchEnabled" } },
      {
        name: "Routine fire URL",
        desc: "The routine's “fire” endpoint from the Claude Code web UI (…/v1/claude_code/routines/<id>/fire).",
        visible: dispatchOn,
        control: { type: "text", key: "cloudRoutineFireUrl", placeholder: "https://api.anthropic.com/v1/claude_code/routines/…/fire" },
      },
      {
        name: "Routine token",
        visible: dispatchOn,
        render: (setting) => {
          setting.setDesc(`Per-routine bearer token (sk-ant-oat…). It only fires this one routine — no account access. ${this.storageBlurb()}`);
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setCssStyles({ width: "320px" });
            text
              .setPlaceholder("sk-ant-oat…")
              .setValue(s.cloudRoutineToken)
              .onChange(async (v) => {
                s.cloudRoutineToken = v.trim();
                await this.plugin.saveSettings();
                this.update();
              });
          });
        },
      },
    ];
  }

  private repliesItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: "Cloud replies setup",
        aliases: ["checklist", "github"],
        render: (setting) => {
          const el = setting.settingEl.createDiv({ cls: "cc-setup-checklist" });
          for (const item of repliesSetupSteps({ repo: s.cloudReplyRepo, branch: s.cloudReplyBranch, folder: s.cloudReplyFolder, token: s.cloudReplyToken })) {
            const row = el.createDiv({ cls: `cc-setup-step ${item.ok ? "is-ok" : "is-err"}` });
            row.createSpan({ cls: "cc-setup-mark", text: item.ok ? "✓" : "✗" });
            row.createSpan({ text: item.detail && !item.ok ? `${item.label} — ${item.detail}` : item.label });
          }
        },
      },
      { name: "Vault repo", desc: "owner/name of the GitHub repo backing your vault.", control: { type: "text", key: "cloudReplyRepo", placeholder: "owner/name" } },
      { name: "Replies branch", desc: "Branch the cloud session writes replies to.", control: { type: "text", key: "cloudReplyBranch", placeholder: "main" } },
      { name: "Replies folder", desc: "Folder in the repo where reply notes land.", control: { type: "text", key: "cloudReplyFolder", placeholder: "Claude/Replies" } },
      {
        name: "GitHub token",
        render: (setting) => {
          setting.setDesc(`Fine-grained token with Contents:read on the repo. ${this.storageBlurb()}`);
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setCssStyles({ width: "min(320px, 100%)" });
            text
              .setPlaceholder("github_pat_… / ghp_…")
              .setValue(s.cloudReplyToken)
              .onChange(async (v) => {
                s.cloudReplyToken = v.trim();
                await this.plugin.saveSettings();
                this.update();
              });
          });
        },
      },
      {
        name: "Test connection",
        desc: "Read the replies folder from GitHub with the current settings — verifies repo, branch, folder, and token in one shot.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          setting.addButton((button) =>
            button.setButtonText("Test").onClick(async () => {
              button.setDisabled(true);
              status.toggleClass("is-ok", false);
              status.toggleClass("is-err", false);
              status.setText("Testing…");
              const result = await this.plugin.testCloudReplies();
              status.toggleClass("is-ok", result.ok);
              status.toggleClass("is-err", !result.ok);
              status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
              button.setDisabled(false);
            }),
          );
        },
      },
    ];
  }

  private publishItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: "GitHub Gist token",
        render: (setting) => {
          setting.setDesc(`Fine-grained token with account permission Gists: read and write. ${this.storageBlurb()}`);
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setCssStyles({ width: "min(320px, 100%)" });
            text
              .setPlaceholder("github_pat_… / ghp_…")
              .setValue(s.publishGithubToken)
              .onChange(async (v) => {
                s.publishGithubToken = v.trim();
                await this.plugin.saveSettings();
              });
          });
        },
      },
      {
        name: "Test Gist token",
        desc: "Ask GitHub whether the token can list gists.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          setting.addButton((button) =>
            button.setButtonText("Test").onClick(async () => {
              button.setDisabled(true);
              status.toggleClass("is-ok", false);
              status.toggleClass("is-err", false);
              status.setText("Testing…");
              const result = await this.plugin.testPublishToken();
              status.toggleClass("is-ok", result.ok);
              status.toggleClass("is-err", !result.ok);
              status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
              button.setDisabled(false);
            }),
          );
        },
      },
      {
        name: "Published items",
        render: (setting) => {
          const list = setting.settingEl.createDiv({ cls: "cc-publish-list" });
          const items = this.plugin.publishedItems();
          if (items.length === 0) list.createDiv({ cls: "cc-publish-empty", text: "Nothing published yet." });
          for (const item of items) {
            const row = list.createDiv({ cls: "cc-publish-row" });
            row.createEl("a", { text: item.title, attr: { href: item.url } });
            row.createSpan({ cls: "cc-publish-kind", text: item.kind });
            const remove = row.createEl("button", { text: "Unpublish" });
            remove.addEventListener("click", () => {
              remove.disabled = true;
              void this.plugin.unpublishItem(item.key).then(() => this.update());
            });
          }
        },
      },
    ];
  }

  private mcpItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const env = (): Record<string, string | undefined> => (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const resolved = (): ReturnType<typeof resolveMcpToken> => resolveMcpToken(env(), s.mcpToken);
    return [
      {
        name: "Enable MCP server",
        desc: "Runs a local server on the port below. Turn off to stop sharing your vault.",
        render: (setting) => {
          setting.addToggle((t) =>
            t.setValue(s.mcpEnabled).onChange(async (v) => {
              s.mcpEnabled = v;
              // Only mint a stored token when neither the env var nor a stored token exists.
              if (v && !resolved().token) s.mcpToken = generateToken();
              await this.plugin.saveSettings();
              this.update();
            }),
          );
        },
      },
      { name: "Port", desc: "Local port for the MCP server (loopback only).", control: { type: "number", key: "mcpPort", min: 1, max: 65535, step: 1 } },
      {
        name: "Access token",
        aliases: ["bearer", MCP_TOKEN_ENV],
        render: (setting) => {
          const r = resolved();
          if (r.source === "env") {
            setting.setDesc(`✓ Sourced from the $${MCP_TOKEN_ENV} environment variable — not stored in this vault. Unset it to use a stored token instead.`);
            return;
          }
          setting.setDesc(`Required by clients as a bearer token. Keep it secret. Tip: set $${MCP_TOKEN_ENV} to source it from the environment instead of this vault's data.`);
          setting
            .addText((text) => {
              text.inputEl.type = "password"; // bearer token — don't render in plaintext
              text.inputEl.setCssStyles({ width: "min(260px, 100%)" });
              text.setValue(s.mcpToken).onChange(async (v) => {
                s.mcpToken = v.trim();
                await this.plugin.saveSettings();
              });
            })
            .addButton((btn) =>
              btn.setButtonText("Regenerate").onClick(async () => {
                s.mcpToken = generateToken();
                await this.plugin.saveSettings();
                this.update();
              }),
            );
        },
      },
      { name: "Allow writes", desc: "Let connected clients create and append notes (read & search are always allowed).", control: { type: "toggle", key: "mcpAllowWrites" } },
      { name: "Agents can record memory", desc: "Add facts to What Claude Knows: outside agents when Allow writes is on, chat when Allow write tools is on.", control: { type: "toggle", key: "memoryRecordEnabled" } },
      { name: "Write folder", desc: "Default folder for notes created via MCP.", control: { type: "text", key: "mcpWriteFolder", placeholder: "Claude/Inbox" } },
      {
        name: "Bridge status",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          const running = this.plugin.mcpRunning();
          status.toggleClass("is-ok", running && s.mcpEnabled);
          status.toggleClass("is-err", s.mcpEnabled && !running);
          if (!s.mcpEnabled) status.setText("Server disabled.");
          else status.setText(running ? `✓ Running at ${bridgeUrl(s.mcpPort)}` : "✗ Not running — check the port isn't in use.");
        },
      },
      {
        name: "Show token in snippets",
        desc: "Off by default so the snippets are safe to screen-share. Copy always copies the real, working command.",
        visible: () => s.mcpEnabled && resolved().source === "stored",
        render: (setting) => {
          setting.addToggle((t) =>
            t.setValue(this.revealMcpToken).onChange((v) => {
              this.revealMcpToken = v;
              this.update();
            }),
          );
        },
      },
      {
        name: "Connection snippets",
        aliases: ["claude desktop", "claude code", "config"],
        visible: () => s.mcpEnabled,
        render: (setting) => {
          const r = resolved();
          if (r.source === "none") {
            setting.setDesc(`Set an access token (or $${MCP_TOKEN_ENV}) to get connection snippets.`);
            return;
          }
          // Display is share-safe (env ref or masked); Copy is the real command.
          const real = { port: s.mcpPort, token: r.token };
          const display = r.source === "env"
            ? { port: s.mcpPort, token: mcpTokenEnvRef() } // expands in the user's shell
            : { port: s.mcpPort, token: this.revealMcpToken ? r.token : maskToken(r.token) };
          const copyInfo = r.source === "env" ? display : real;
          this.codeBlock(setting.settingEl, "Advanced Claude Code MCP connection (ordinary use is CLI-first):", claudeCodeCommand(display), claudeCodeCommand(copyInfo));
          this.codeBlock(setting.settingEl, "Claude Desktop (add to claude_desktop_config.json):", claudeDesktopConfig(display), claudeDesktopConfig(copyInfo));
        },
      },
    ];
  }

  private codeBlock(containerEl: HTMLElement, label: string, code: string, copyText: string = code): void {
    const wrap = containerEl.createDiv({ cls: "cc-snippet" });
    const head = wrap.createDiv({ cls: "cc-snippet-head" });
    head.createSpan({ text: label });
    const copy = head.createEl("button", { cls: "cc-action", text: "Copy" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(copyText);
      copy.setText("Copied");
      window.setTimeout(() => copy.setText("Copy"), 1200);
    });
    wrap.createEl("pre", { cls: "cc-snippet-pre" }).createEl("code", { text: code });
  }

  private renderStatus(el: HTMLElement, status: ProviderStatus): void {
    el.empty();
    el.toggleClass("is-ok", status.ok);
    el.toggleClass("is-err", !status.ok);
    el.setText((status.ok ? "✓ " : "✗ ") + status.detail);
  }

  /** After an embedding model/engine switch: the old index no longer applies. */
  private offerIndexRebuild(label: string): void {
    new ChoiceModal<"rebuild" | "later">(this.app, {
      title: "Rebuild the semantic index?",
      message: `Embeddings now come from ${label}, so the existing index no longer applies. Rebuild it now, or it refreshes gradually as notes change.`,
      buttons: [
        { label: "Rebuild now", value: "rebuild", cta: true },
        { label: "Later", value: "later" },
      ],
      fallback: "later",
      onChoice: (c) => {
        if (c === "rebuild") void this.plugin.rebuildSemanticIndex();
      },
    }).open();
  }
}

function splitTags(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

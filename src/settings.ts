import { App, Notice, Platform, PluginSettingTab, Setting, type ButtonComponent, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "./main";
import { CLAUDE_MODELS } from "./claude/models";
import type { ProviderStatus } from "./providers/types";
import { readAnthropicEnv, hasAnthropicEnvCredential } from "./providers/env";
import { mergeDetectedModels } from "./providers/localModels";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "./mcp/clientConfig";
import { dispatchSetupSteps, repliesSetupSteps } from "./cloud/setup";
import { BUILTIN_EMBEDDING_MODELS, builtinModelById } from "./semantic/transformers/model";
import { ChoiceModal } from "./view/ChoiceModal";
import { normalizeDiscoverySettings, type McpServerConfig, type PluginSettings } from "./types";

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
  "apiKey", "oauthToken", "baseUrl", "customModel", "ollamaUtilityModel", "openaiCompatHost", "openaiCompatKey",
  "openAlexContactEmail", "zoteroUserId", "zoteroApiKey", "braveSearchApiKey", "cloudRoutineFireUrl",
  "cloudRoutineToken", "cloudRoutineBetaHeader", "cloudReplyRepo", "cloudReplyToken", "mcpToken",
] as const) trimmed(key);

for (const [key, fallback] of [
  ["artifactFolder", "Claude/Artifacts"], ["chatFolder", "Claude/Chats"], ["planFolder", "Claude/Plans"],
  ["templatesFolder", "Claude/Templates"], ["memoryFolder", "Claude/Sessions"], ["sourceInboxFolder", "Clippings"],
  ["clipOrganizedFolder", "Library"], ["ontologyFolder", "Ontology"], ["cloudReplyBranch", "main"],
  ["cloudReplyFolder", "Claude/Replies"], ["mcpWriteFolder", "Claude/Inbox"], ["ollamaHost", "http://localhost:11434"],
  ["ollamaModel", "llama3.1"], ["embeddingModel", "nomic-embed-text"],
] as const) trimmedOr(key, fallback);

for (const key of ["artifactBaseTags", "chatBaseTags", "sourceBaseTags"] as const) tagList(key);

for (const key of ["discoveryMaxResults", "discoveryExpansionLimit", "discoveryCacheHours"] as const) {
  CODECS[key] = {
    read: (s) => s[key],
    write: (s, v) => { Object.assign(s, normalizeDiscoverySettings({ ...s, [key]: Number(v) })); },
  };
}

export class ClaudeCompanionSettingTab extends PluginSettingTab {
  /** Cached list of Ollama models from the last Detect, for the dropdown. */
  private detectedOllamaModels: string[] | null = null;
  /** Same, for the OpenAI-compatible endpoint (LM Studio, mlx-lm, vLLM, Jan). */
  private detectedEndpointModels: string[] | null = null;
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  private revealMcpToken = false;

  constructor(
    app: App,
    private plugin: ClaudeCompanionPlugin,
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
      case "intelligenceNarrator":
      case "openaiCompatModel":
        if (key === "chatBackend" && this.plugin.settings.chatBackend === "claude-cli") void this.plugin.router().claudeCli.refresh().then(() => this.plugin.refreshViews());
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
      case "cloudRoutineBetaHeader":
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
    return [
      { type: "group", items: this.introItems() },
      { type: "group", heading: "Connection", items: this.connectionItems() },
      { type: "group", heading: "Behavior", items: this.behaviorItems() },
      {
        type: "group",
        heading: "Agent",
        items: [
          { type: "page", name: "Agent (act on your vault)", items: this.agentItems() },
          { type: "page", name: "Agent bridge — MCP server (desktop)", visible: () => !Platform.isMobile, items: this.mcpItems() },
          { type: "page", name: "External tools — MCP client", items: this.mcpClientItems() },
          { type: "page", name: "Agent in the cloud (mobile-friendly)", items: this.cloudItems() },
          { type: "page", name: "Cloud replies (pull from repo)", items: this.repliesItems() },
        ],
      },
      {
        type: "group",
        heading: "Vault intelligence",
        items: [
          { type: "page", name: "Semantic search (local embeddings)", items: this.semanticItems() },
          { type: "page", name: "Local models (Ollama & endpoints)", visible: () => !Platform.isMobile, items: this.localModelsItems() },
          { type: "page", name: "Indexing & tags", items: this.indexingItems() },
          { type: "page", name: "Source capture (typed clips)", items: this.sourceCaptureItems() },
          { type: "page", name: "Vault ontology (typed notes & relations)", items: this.ontologyItems() },
          { type: "page", name: "Scholarly discovery", items: this.discoveryItems() },
        ],
      },
      {
        type: "group",
        heading: "Files, memory & privacy",
        items: [
          { type: "page", name: "Session memory", visible: () => !Platform.isMobile, items: this.memoryItems() },
          { type: "page", name: "Storage", items: this.storageItems() },
          { type: "page", name: "What this plugin accesses (privacy)", items: this.privacyItems() },
          { type: "page", name: "Desktop-only features", visible: () => Platform.isMobile, items: this.desktopOnlyItems() },
        ],
      },
    ];
  }

  /** Callouts and the desktop-integrations entry point, above the first heading. */
  private introItems(): SettingGroupItem[] {
    return [
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
        visible: () => !this.plugin.router().anthropic.hasCredentials(),
        render: (setting) => {
          const callout = setting.settingEl.createDiv({ cls: "cc-connect-callout" });
          const p = callout.createEl("p");
          p.appendText("Add an Anthropic API key below to start chatting. Create one at ");
          p.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
          p.appendText(` — ${this.storageBlurb().replace(/^S/, "s")}`);
        },
      },
      {
        name: "Desktop integrations",
        desc: "Install the CAVI marketplace plugin and merge the Claude Desktop config.",
        aliases: ["marketplace", "claude desktop", "obsidian-agent"],
        render: (setting) => {
          setting.addButton((btn) => {
            btn.buttonEl.addClass("cc-settings-desktop-integrations");
            btn.setButtonText("Desktop integrations").onClick(() => this.plugin.openDesktopIntegrations());
          });
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
        desc: "Where chat runs. Auto keeps using Claude but transparently falls back to your local model when Claude is offline or out of usage — so you never lose chat on a plane or when tokens run out. Claude Code uses the claude command already signed in on this computer — no key needed; chat only.",
        control: {
          type: "dropdown",
          key: "chatBackend",
          options: {
            claude: "Claude only",
            "claude-cli": "Claude Code — your subscription (desktop)",
            auto: "Auto (Claude, fall back to local)",
            local: "Local only — Ollama (offline)",
            custom: "Local only — OpenAI-compatible endpoint",
          },
        },
      },
      {
        name: "Claude Code",
        desc: "Status of the claude command this backend runs. Companion never sees your credentials; Claude Code holds them.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          const probe = this.plugin.router().claudeCli.probe();
          if (probe) this.renderStatus(status, { ok: probe.loggedIn, detail: probe.loggedIn ? `Claude Code ${probe.version} · signed in via ${probe.method} · ${probe.executable}` : "Not signed in — run `claude auth login`." });
          setting.addButton((btn) =>
            btn
              .setButtonText("Check Claude Code")
              .onClick(async () => {
                this.renderStatus(status, { ok: true, detail: "Checking…" });
                const result = await this.plugin.router().claudeCli.test();
                this.renderStatus(status, result);
                this.plugin.refreshViews();
                if (result.ok) await this.plugin.runFirstRunPrompts();
              }),
          );
        },
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
      { name: "Inline artifact height", desc: "Default pixel height for artifacts rendered inside notes.", control: { type: "number", key: "artifactHeight", min: 1, step: 1 } },
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
      { name: "About session memory", desc: "Capture Claude Code CLI sessions for this vault into sanitized digest notes. Desktop-only; sessions are matched by the directory you ran Claude Code in." },
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
      {
        name: "About the agent",
        desc:
          "One agent, three surfaces. In chat: Claude searches, reads, and — with writes on — edits your vault, asking before every write. "
          + "On desktop, Claude Code uses the official Obsidian CLI by default; the optional bridge serves Claude Desktop and advanced live-vault clients. "
          + "On mobile, a Cloud session works your vault's Git repo and writes replies back.",
      },
      { name: "Let Claude use vault tools", desc: "Claude can search and read your notes on its own while answering (read-only). Turn off for plain chat with pre-attached context.", control: { type: "toggle", key: "agentModeEnabled" } },
      { name: "Allow write tools", desc: "Also let Claude create, edit, and move notes from chat. Every write asks for your confirmation first.", control: { type: "toggle", key: "agentAllowWrites" } },
      { name: "Review edits in the editor", desc: "When the note is open, show proposed changes inline with word-level highlights and per-change Accept/Reject instead of a dialog.", control: { type: "toggle", key: "inlineDiffEnabled" } },
      { name: "Rewrite button on selection", desc: "Show a small “Rewrite with Claude” action above selected text. Desktop only.", control: { type: "toggle", key: "selectionActionEnabled" } },
      { name: "Max tool iterations per turn", desc: "How many search/read/write rounds Claude may take before it must answer.", control: { type: "slider", key: "agentMaxIterations", min: 1, max: 20, step: 1 } },
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
      { name: "About source capture", desc: "Point the Obsidian Web Clipper (and dropped CSVs) at an inbox folder; Companion types each new file into a schema-validated source note. Extraction uses your utility model (local if enabled)." },
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

  private discoveryItems(): SettingGroupItem[] {
    return [
      {
        name: "Research intelligence narrator",
        desc: "Choose the provider used only when you click Analyze in a Research Intelligence view. Deterministic findings stay local and always remain available.",
        control: { type: "dropdown", key: "intelligenceNarrator", options: { current: "Current chat backend", claude: "Claude only", local: "Local only", disabled: "Disabled" } },
      },
      { name: "When discovery reaches the network", desc: "Network requests happen only when you explicitly run a discovery action. Results are derived suggestions, and imported sources remain unreviewed until you review them." },
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
        name: "Discovery reranker",
        desc: "Provider used only when you explicitly rerank derived discovery results.",
        control: { type: "dropdown", key: "discoveryReranker", options: { current: "Current chat backend", claude: "Claude only", local: "Local only", disabled: "Disabled" } },
      },
      { name: "Maximum search results", desc: "Per request, from 5 to 100.", control: { type: "number", key: "discoveryMaxResults", min: 5, max: 100, step: 1 } },
      { name: "Citation expansion limit", desc: "Per expansion request, from 5 to 50.", control: { type: "number", key: "discoveryExpansionLimit", min: 5, max: 50, step: 1 } },
      { name: "Derived cache lifetime", desc: "Hours to retain derived discovery results, from 1 to 168.", control: { type: "number", key: "discoveryCacheHours", min: 1, max: 168, step: 1 } },
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
    return [
      { name: "About local models", desc: "Run cheap, bulk work — summarizing, tagging, ingestion — on a local model to save Anthropic tokens. Chat and plans still use Claude unless you route them here." },
      {
        name: "Utility tasks backend",
        desc: "Summaries, auto-tagging, and ingestion go to this backend instead of Claude. Claude Code sign-in covers chat only. Background tasks (tagging, source enrichment, memory) need an API key or a local model.",
        control: { type: "dropdown", key: "utilityBackend", options: { claude: "Claude", ollama: "Ollama (local)", custom: "OpenAI-compatible endpoint" } },
      },
      { name: "Ollama host", desc: "Base URL of your local Ollama server.", control: { type: "text", key: "ollamaHost", placeholder: "http://localhost:11434" } },
      {
        name: "Local chat model",
        desc: "Choose a detected model, or type one (e.g. llama3.1, qwen2.5). Click Detect to refresh the list.",
        render: (setting) => {
          const detected = this.detectedOllamaModels;
          if (detected && detected.length > 0) {
            setting.addDropdown((dd) => {
              for (const m of detected) dd.addOption(m, m);
              // Keep the current value selectable even if not in the detected list.
              if (!detected.includes(this.plugin.settings.ollamaModel)) dd.addOption(this.plugin.settings.ollamaModel, `${this.plugin.settings.ollamaModel} (current)`);
              dd.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
                this.plugin.settings.ollamaModel = v;
                await this.plugin.saveSettings();
              });
            });
          } else {
            setting.addText((text) =>
              text.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
                this.plugin.settings.ollamaModel = v.trim() || "llama3.1";
                await this.plugin.saveSettings();
              }),
            );
          }
          setting.addButton((btn) =>
            btn
              .setButtonText("Detect")
              .setTooltip("Query the Ollama server for installed models")
              .onClick(async () => {
                await this.plugin.saveSettings();
                btn.setButtonText("Detecting…").setDisabled(true);
                const models = await this.plugin.router().ollama.listModels();
                this.detectedOllamaModels = models;
                if (models.length === 0) {
                  new Notice("No Ollama models detected. Is `ollama serve` running, and have you pulled a model?");
                } else {
                  if (!models.includes(this.plugin.settings.ollamaModel)) {
                    const first = models[0];
                    if (first) this.plugin.settings.ollamaModel = first;
                    await this.plugin.saveSettings();
                  }
                  new Notice(`Detected ${models.length} model(s).`);
                }
                this.update(); // rebuild the row so the dropdown appears/updates
              }),
          );
          // Capability badges per detected model — tools gates the agent; thinking
          // means the model reasons before answering.
          const capsEl = setting.settingEl.createDiv({ cls: "cc-model-caps setting-item-description" });
          void (async () => {
            const models = this.detectedOllamaModels ?? [];
            if (models.length === 0) return;
            const ollama = this.plugin.router().ollama;
            for (const m of models) {
              const caps = await ollama.capabilities(m);
              const tools = caps.includes("tools");
              const thinking = caps.includes("thinking");
              const row = capsEl.createDiv({ cls: "cc-model-caps-row" });
              row.createSpan({ text: m, cls: "cc-model-caps-name" });
              row.createSpan({ text: `tools ${tools ? "✓" : "✗"}`, cls: tools ? "is-ok" : "is-err" });
              row.createSpan({ text: `thinking ${thinking ? "✓" : "✗"}`, cls: thinking ? "is-ok" : "" });
              if (!tools) row.createSpan({ text: " — chat only, no agent", cls: "setting-item-description" });
            }
          })();
        },
      },
      {
        name: "Test local connection",
        desc: "Checks that Ollama is reachable and lists pulled models.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          setting.addButton((btn) =>
            btn.setButtonText("Test Ollama").onClick(async () => {
              await this.plugin.saveSettings();
              this.renderStatus(status, { ok: true, detail: "Testing…" });
              this.renderStatus(status, await this.plugin.router().ollama.test());
            }),
          );
        },
      },
      { name: "Utility model (optional)", desc: "A smaller model for utility tasks (tagging, summaries, ingestion). Empty = use the chat model above. A 1–3B model is plenty and much faster.", control: { type: "text", key: "ollamaUtilityModel" } },
      { name: "About the OpenAI-compatible endpoint", desc: "Point at LM Studio, mlx-lm, vLLM, Jan, or Ollama's /v1 mode — including Apple-silicon-optimized servers like `mlx_lm.server`. Select it as the chat backend or utility backend above, and as an embedding engine under Semantic search." },
      { name: "Endpoint host", desc: "Base URL, with or without /v1 (e.g. http://localhost:1234).", control: { type: "text", key: "openaiCompatHost", placeholder: "http://localhost:1234" } },
      {
        name: "Endpoint model",
        desc: "Choose a model the server exposes, or type its id. Click Detect to refresh the list.",
        render: (setting) => {
          const detected = this.detectedEndpointModels;
          if (detected && detected.length > 0) {
            setting.addDropdown((dd) => {
              const models = mergeDetectedModels(detected, this.plugin.settings.openaiCompatModel);
              for (const m of models) dd.addOption(m, m);
              const current = this.plugin.settings.openaiCompatModel.trim() || models[0] || "";
              dd.setValue(current).onChange(async (v) => {
                this.plugin.settings.openaiCompatModel = v;
                await this.plugin.saveSettings();
                this.plugin.refreshViews();
              });
            });
          } else {
            setting.addText((text) =>
              text.setValue(this.plugin.settings.openaiCompatModel).onChange(async (v) => {
                this.plugin.settings.openaiCompatModel = v.trim();
                await this.plugin.saveSettings();
                this.plugin.refreshViews();
              }),
            );
          }
          setting.addButton((btn) =>
            btn
              .setButtonText("Detect")
              .setTooltip("Query the endpoint for the models it serves")
              .onClick(async () => {
                await this.plugin.saveSettings();
                btn.setButtonText("Detecting…").setDisabled(true);
                const models = await this.plugin.router().openaiCompat.listModels();
                this.detectedEndpointModels = models;
                if (models.length === 0) {
                  new Notice("No models detected. Check the endpoint host, and that the server has a model loaded.");
                } else {
                  if (!models.includes(this.plugin.settings.openaiCompatModel)) {
                    const first = models[0];
                    if (first) this.plugin.settings.openaiCompatModel = first;
                    await this.plugin.saveSettings();
                  }
                  new Notice(`Detected ${models.length} model(s).`);
                }
                this.plugin.refreshViews();
                this.update();
              }),
          );
        },
      },
      {
        name: "Endpoint API key",
        desc: "Optional. Most local servers accept anything or nothing.",
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.settings.openaiCompatKey).onChange(async (v) => {
              this.plugin.settings.openaiCompatKey = v.trim();
              await this.plugin.saveSettings();
            });
          });
        },
      },
      {
        name: "Test endpoint",
        desc: "Checks the endpoint is reachable and lists its models.",
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
          setting.addButton((btn) =>
            btn.setButtonText("Test endpoint").onClick(async () => {
              await this.plugin.saveSettings();
              this.renderStatus(status, { ok: true, detail: "Testing…" });
              this.renderStatus(status, await this.plugin.router().openaiCompat.test());
            }),
          );
        },
      },
    ];
  }

  private semanticItems(): SettingGroupItem[] {
    const enabled = (): boolean => this.plugin.settings.semanticEnabled;
    return [
      { name: "Enable semantic search", desc: "Build a local vector index so the vault is searchable by meaning, not just keywords. Private and on-device. Powers the “Search vault” context and Ask-your-vault.", control: { type: "toggle", key: "semanticEnabled" } },
      {
        name: "Embedding engine",
        desc: "Built-in runs a small model inside Obsidian on every platform (one-time download). Ollama uses your local Ollama server (desktop). Endpoint uses the OpenAI-compatible server from Local models.",
        visible: enabled,
        render: (setting) => {
          setting.addDropdown((dd) => {
            dd.addOption("builtin", "Built-in (recommended)");
            dd.addOption("ollama", "Ollama");
            dd.addOption("custom", "OpenAI-compatible endpoint");
            dd.setValue(this.plugin.settings.embeddingEngine).onChange(async (v) => {
              if (v === this.plugin.settings.embeddingEngine) return;
              const hadNotes = ((await this.plugin.indexer()?.stats().catch(() => null))?.notes ?? 0) > 0;
              this.plugin.settings.embeddingEngine = v as PluginSettings["embeddingEngine"];
              await this.plugin.saveSettings();
              this.plugin.invalidateIndexer();
              this.update();
              if (hadNotes) this.offerIndexRebuild(v === "builtin" ? "the built-in model" : v);
            });
          });
        },
      },
      {
        name: "Built-in model",
        desc: "Larger models index more accurately at a slower speed and bigger download. Switching rebuilds the index.",
        visible: () => enabled() && this.plugin.settings.embeddingEngine === "builtin",
        render: (setting) => {
          setting.addDropdown((dd) => {
            for (const m of BUILTIN_EMBEDDING_MODELS) {
              dd.addOption(m.id, `${m.hfRepo.split("/")[1]} · ${m.dim}d · ~${m.approxDownloadMB} MB`);
            }
            dd.setValue(builtinModelById(this.plugin.settings.builtinEmbeddingModel).id).onChange(async (v) => {
              if (v === this.plugin.settings.builtinEmbeddingModel) return;
              const hadNotes = ((await this.plugin.indexer()?.stats().catch(() => null))?.notes ?? 0) > 0;
              const label = v.replace(/^builtin:/, "");
              this.plugin.settings.builtinEmbeddingModel = v;
              await this.plugin.saveSettings();
              this.plugin.invalidateIndexer();
              this.update();
              if (hadNotes) this.offerIndexRebuild(label);
            });
          });
        },
      },
      {
        name: "Embedding model",
        visible: () => enabled() && this.plugin.settings.embeddingEngine === "builtin",
        render: (setting) => {
          const model = builtinModelById(this.plugin.settings.builtinEmbeddingModel);
          const backend = this.plugin.builtinEmbedder().backend();
          setting.setDesc(`${model.hfRepo} (~${model.approxDownloadMB} MB from huggingface.co + ~23 MB ONNX runtime from cdn.jsdelivr.net, one-time; cached and fully on-device afterwards).`);
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
          status.setText(backend ? `Model ready · ${backend === "webgpu" ? "WebGPU" : "WASM"}` : "Model not downloaded yet.");

          let mainBtn: ButtonComponent | null = null;
          let clearBtn: ButtonComponent | null = null;
          setting.addButton((btn) => {
            // Non-CTA: delete the downloaded model from the local cache. Hidden
            // until we know there is something to clear (loaded or cached).
            clearBtn = btn;
            btn.setButtonText("Clear").onClick(async () => {
              btn.setDisabled(true);
              await this.plugin.clearBuiltinModel();
              this.update(); // status returns to "Model not downloaded yet."
            });
            if (!backend) btn.buttonEl.hide();
          });
          setting.addButton((btn) => {
            mainBtn = btn;
            btn
              .setButtonText(backend ? "Re-check" : `Download (~${model.approxDownloadMB} MB)`)
              .setCta()
              .onClick(async () => {
                btn.setDisabled(true);
                try {
                  await this.plugin.builtinEmbedder().download((p) => status.setText(`Downloading… ${p.percent}% (${p.file})`));
                  const b = this.plugin.builtinEmbedder().backend();
                  status.setText(`Model ready · ${b === "webgpu" ? "WebGPU" : "WASM"}`);
                  clearBtn?.buttonEl.show();
                } catch (e) {
                  status.setText(`Download failed: ${e instanceof Error ? e.message : String(e)} — check your connection and retry.`);
                } finally {
                  btn.setDisabled(false);
                }
              });
          });
          if (!backend) {
            // Distinguish "downloaded earlier, not loaded this session" (offline
            // load) from "never downloaded" (network download needing consent).
            void this.plugin.builtinModelCached().then((cached) => {
              if (!cached) return;
              status.setText("Model cached — loads on first use.");
              mainBtn?.setButtonText("Load");
              clearBtn?.buttonEl.show();
            });
          }
        },
      },
      {
        name: "Ollama embedding model",
        desc: "An Ollama embedding model. Pull one first, e.g. `ollama pull nomic-embed-text`.",
        visible: () => enabled() && this.plugin.settings.embeddingEngine === "ollama",
        render: (setting) => {
          setting.addDropdown((dd) => {
            const cur = this.plugin.settings.embeddingModel || "nomic-embed-text";
            // Always show the current selection; the running server's models are
            // added asynchronously below.
            dd.addOption(cur, cur);
            dd.setValue(cur).onChange(async (v) => {
              this.plugin.settings.embeddingModel = v.trim() || "nomic-embed-text";
              await this.plugin.saveSettings();
            });
            void this.plugin
              .router()
              .ollama.listModels()
              .then((models) => {
                for (const m of models) if (m !== cur) dd.addOption(m, m);
              })
              .catch(() => {
                /* Ollama not reachable — leave just the current value. */
              });
          });
        },
      },
      {
        name: "Endpoint embedding model",
        desc: "An embedding model the OpenAI-compatible endpoint (configured under Local models) serves, e.g. text-embedding-nomic-embed-text-v1.5.",
        visible: () => enabled() && this.plugin.settings.embeddingEngine === "custom",
        render: (setting) => {
          setting.addDropdown((dd) => {
            const cur = this.plugin.settings.openaiCompatEmbeddingModel;
            // Always show the current selection; the endpoint's models are added
            // asynchronously below.
            if (cur) dd.addOption(cur, cur);
            else dd.addOption("", "Not set — pick one once detected");
            dd.setValue(cur).onChange(async (v) => {
              this.plugin.settings.openaiCompatEmbeddingModel = v.trim();
              await this.plugin.saveSettings();
              this.plugin.invalidateIndexer();
            });
            void this.plugin
              .router()
              .openaiCompat.listModels()
              .then((models) => {
                for (const m of models) if (m !== cur) dd.addOption(m, m);
              })
              .catch(() => {
                /* Endpoint not reachable — leave just the current value. */
              });
          });
        },
      },
      {
        name: "Index PDF text",
        desc: "Extract text from vault PDFs into the semantic index (page numbers kept, so results cite the page). Rebuilds the index on the next save or manual rebuild.",
        visible: enabled,
        control: { type: "toggle", key: "semanticIndexPdfs" },
      },
      {
        name: "Rebuild index",
        desc: "Embed every note now. Re-embeds only changed notes on save afterward.",
        visible: enabled,
        render: (setting) => {
          const status = setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
          void this.plugin
            .indexer()
            ?.stats()
            .then((s) => status.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`))
            .catch(() => status.setText("Index: not built yet."));
          setting.addButton((btn) =>
            btn
              .setButtonText("Rebuild")
              .setCta()
              .onClick(async () => {
                await this.plugin.rebuildSemanticIndex();
                const s = await this.plugin.indexer()?.stats();
                if (s) status.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`);
              }),
          );
        },
      },
    ];
  }

  private mcpClientItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const items: SettingGroupItem[] = [
      {
        name: "About external MCP servers",
        desc:
          "Let the in-chat agent use tools from external MCP servers — Companion can serve its vault through the optional desktop bridge and consume other servers here. "
          + "Every external tool call asks for your confirmation. HTTP servers work on mobile; stdio commands run on desktop only.",
      },
    ];
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
        name: "About cloud dispatch",
        desc:
          "Dispatch a Claude Code session in the cloud to work your vault's Git repo and report back — so you can cowork with Claude from a phone, where the local bridge can't run. "
          + "The Routines API is experimental; if Anthropic ships a newer beta revision, update the header below. "
          + "In the Claude Code web UI, create a routine pointed at your vault's Git repo, then complete the checklist.",
      },
      {
        name: "Cloud dispatch setup",
        aliases: ["checklist", "routine"],
        render: (setting) => {
          const el = setting.settingEl.createDiv({ cls: "cc-setup-checklist" });
          const steps = dispatchSetupSteps({ fireUrl: s.cloudRoutineFireUrl, token: s.cloudRoutineToken, betaHeader: s.cloudRoutineBetaHeader });
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
      {
        name: "API beta header",
        desc: "anthropic-beta header gating the experimental Routines API. Update if Anthropic ships a newer dated version.",
        visible: dispatchOn,
        control: { type: "text", key: "cloudRoutineBetaHeader" },
      },
      {
        name: "What cloud dispatch sends",
        visible: dispatchOn,
        render: (setting) => {
          const warn = setting.settingEl.createEl("p", { cls: "setting-item-description" });
          warn.setCssStyles({ color: "var(--text-warning)" });
          warn.setText(
            "⚠️ Unlike the local bridge, this sends your prompt + attached note context to Anthropic's cloud and runs against your vault's Git repo. "
              + `${this.storageBlurb()} Use a private repo.`,
          );
        },
      },
    ];
  }

  private repliesItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: "About cloud replies",
        desc:
          "Pull notes a cloud session wrote back into your vault's GitHub repo — over HTTPS, so it works on a phone with no local git. "
          + "Point this at the repo, branch, and folder the session writes replies to.",
      },
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

  private mcpItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const env = (): Record<string, string | undefined> => (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const resolved = (): ReturnType<typeof resolveMcpToken> => resolveMcpToken(env(), s.mcpToken);
    return [
      {
        name: "About the MCP bridge",
        desc: "Optional advanced bridge for Claude Desktop and live-vault API clients. Claude Code uses the official Obsidian CLI by default and does not need this server. Bound to 127.0.0.1 and protected by a token.",
      },
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

import { App, Notice, Platform, PluginSettingTab, Setting, type ButtonComponent } from "obsidian";
import type ClaudeCompanionPlugin from "./main";
import { CLAUDE_MODELS } from "./claude/models";
import type { ProviderStatus } from "./providers/types";
import { readAnthropicEnv, hasAnthropicEnvCredential } from "./providers/env";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "./mcp/clientConfig";
import { dispatchSetupSteps, repliesSetupSteps } from "./cloud/setup";
import { BUILTIN_EMBEDDING_MODELS, builtinModelById } from "./semantic/transformers/model";
import { ChoiceModal } from "./view/ChoiceModal";
import { normalizeDiscoverySettings, type McpServerConfig, type PluginSettings } from "./types";

export class ClaudeCompanionSettingTab extends PluginSettingTab {
  /** Cached list of Ollama models from the last Detect, for the dropdown. */
  private detectedOllamaModels: string[] | null = null;
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  private revealMcpToken = false;

  /** Where credentials actually land, so the copy can't claim safety it doesn't have. */
  private storageBlurb(): string {
    return this.plugin.secrets().available()
      ? "Stored in your device's secret storage, not in this vault."
      : "Stored locally in this vault's plugin data.";
  }

  constructor(
    app: App,
    private plugin: ClaudeCompanionPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cc-settings-root");

    // Top-level blocks re-render in place (their own div), never the whole
    // tab — a full re-render collapses every accordion and resets scroll.
    const topEl = containerEl.createDiv();
    const renderTop = (): void => {
      topEl.empty();
      this.renderTopSection(topEl, renderTop);
    };
    renderTop();

    // One accordion per feature, ordered by user journey: run Claude → give
    // it tools → teach it the vault → where files go → what it can see.
    this.groupHeading(containerEl, "Agent");
    this.accordion(containerEl, "Agent (act on your vault)", (c, rerender) => this.renderAgentSection(c, rerender));
    if (!Platform.isMobile) {
      this.accordion(containerEl, "Agent bridge — MCP server (desktop)", (c, rerender) => this.renderMcpSection(c, rerender));
    }
    this.accordion(containerEl, "External tools — MCP client", (c, rerender) => this.renderMcpClientSection(c, rerender));
    this.accordion(containerEl, "Agent in the cloud (mobile-friendly)", (c, rerender) => this.renderCloudSection(c, rerender));
    this.accordion(containerEl, "Cloud replies (pull from repo)", (c) => this.renderRepliesSection(c));

    this.groupHeading(containerEl, "Vault intelligence");
    this.accordion(containerEl, "Semantic search (local embeddings)", (c) => this.renderSemanticSection(c));
    if (!Platform.isMobile) {
      this.accordion(containerEl, "Local models (Ollama & endpoints)", (c, rerender) => this.renderLocalModelsSection(c, rerender));
    }
    this.accordion(containerEl, "Indexing & tags", (c) => this.renderIndexingSection(c));
    // Source capture is vault-API based (no Node/fs) → works on mobile, so it
    // stays in the shared group rather than a desktop-only block.
    this.accordion(containerEl, "Source capture (typed clips)", (c) => this.renderSourceCaptureSection(c));
    this.accordion(containerEl, "Vault ontology (typed notes & relations)", (c) => this.renderOntologySection(c));
    this.accordion(containerEl, "Scholarly discovery", (c) => this.renderDiscoverySection(c));

    this.groupHeading(containerEl, "Files, memory & privacy");
    if (!Platform.isMobile) {
      this.accordion(containerEl, "Session memory", (c) => this.renderMemorySection(c));
    }
    this.accordion(containerEl, "Storage", (c) => this.renderStorageSection(c));
    this.accordion(containerEl, "What this plugin accesses (privacy)", (c) => {
      c.createEl("p", {
        cls: "setting-item-description",
        text: "Your messages and vault context go only to Anthropic (and your local Ollama, if enabled) — nothing else leaves your machine. The built-in semantic-search engine downloads its model once from huggingface.co and cdn.jsdelivr.net when you click Download; afterwards it runs fully offline. On desktop, optional features touch files outside the vault: session capture reads Claude Code transcripts from your Claude projects folder, and “open artifact in browser” writes a temporary HTML file. Semantic search reads every note in your vault to build a local index. Copy buttons use the system clipboard. All filesystem access is disabled on mobile.",
      });
    });

    if (Platform.isMobile) {
      // Desktop-only features are hidden on a phone (they need a desktop runtime);
      // one collapsed note explains where they went so nothing feels missing.
      this.accordion(containerEl, "🖥 Desktop-only features", (body) => {
        body.createEl("p", {
          text: "These need a desktop runtime and are available when you open this vault on a computer:",
        });
        const ul = body.createEl("ul");
        for (const t of [
          "Local models (Ollama & endpoints) — runs a localhost model server",
          "Claude Desktop / advanced bridge — token-protected live-vault MCP",
          "Session capture — reads Claude Code transcripts from disk (browsing captured memory works here)",
        ]) {
          ul.createEl("li", { text: t });
        }
      });
    }
  }

  private renderTopSection(containerEl: HTMLElement, rerenderTop: () => void): void {
    const s = this.plugin.settings;

    // Below 1.11.5 there is no OS-encrypted secret store, so credentials stay in
    // this vault's data.json and ride vault sync. Say so rather than implying safety.
    if (!this.plugin.secrets().available()) {
      const warn = containerEl.createDiv({ cls: "cc-connect-callout" });
      warn.createDiv({ cls: "cc-connect-title", text: "Credentials are stored in this vault" });
      const p = warn.createEl("p");
      p.appendText(
        "This version of Obsidian has no encrypted secret storage, so keys and tokens are written to this vault’s "
          + "data.json — if the vault syncs to iCloud, Dropbox, or git, they sync with it. "
          + "Update Obsidian to 1.11.5 or later and Companion will move them into your device’s keychain automatically.",
      );
      if (Platform.isLinux) {
        p.appendText(" On Linux that also needs kwallet or gnome-libsecret installed.");
      }
    }

    const desktopIntegrations = containerEl.createEl("button", {
      cls: "cc-settings-desktop-integrations",
      text: "Desktop integrations",
      attr: { type: "button" },
    });
    desktopIntegrations.addEventListener("click", () => this.plugin.openDesktopIntegrations());

    // The one mandatory step, called out while it's missing. Everything else
    // in this tab is optional.
    if (!this.plugin.router().anthropic.hasCredentials()) {
      const callout = containerEl.createDiv({ cls: "cc-connect-callout" });
      callout.createDiv({ cls: "cc-connect-title", text: "Step 1 — connect to Claude" });
      const p = callout.createEl("p");
      p.appendText("Add an Anthropic API key below to start chatting. Create one at ");
      p.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
      p.appendText(` — ${this.storageBlurb().replace(/^S/, "s")}`);
    }

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Authentication")
      .setDesc("How Companion for Claude authenticates to Anthropic. API key is the standard, store-safe option.")
      .addDropdown((dd) => {
        dd.addOption("apiKey", "API key (recommended)");
        dd.addOption("oauthToken", "Long-term OAuth token (subscription)");
        dd.addOption("environment", "Import from environment");
        dd.setValue(s.authMode).onChange(async (v) => {
          s.authMode = v as typeof s.authMode;
          await this.plugin.saveSettings();
          rerenderTop(); // re-render only this block to show the matching field
        });
      });

    if (s.authMode === "apiKey") {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .setDesc((() => {
          const frag = activeDocument.createDocumentFragment();
          frag.appendText("Bring your own key from ");
          frag.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
          frag.appendText(`. ${this.storageBlurb()}`);
          return frag;
        })())
        .addText((text) => {
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
    } else if (s.authMode === "oauthToken") {
      const note = containerEl.createEl("p", { cls: "setting-item-description" });
      note.setText(
        "Paste a long-term token from `claude setup-token` (starts with sk-ant-oat). " +
          "Requests authenticate as your Claude subscription, so usage draws on your plan's limits rather than pay-as-you-go API credit. " +
          "This is a power-user option; the API-key mode above is the one used for community-store builds.",
      );
      new Setting(containerEl)
        .setName("OAuth token")
        .setDesc(`${this.storageBlurb()} Sent as a bearer token.`)
        .addText((text) => {
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
    } else {
      const env = readAnthropicEnv();
      const found = hasAnthropicEnvCredential(env);
      const detail = found
        ? `Using ${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"}` + (env.ANTHROPIC_BASE_URL ? ` + ANTHROPIC_BASE_URL` : "") + " from the environment."
        : "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found in this process's environment. Note: apps launched from the macOS Dock often don't inherit shell exports — launch Obsidian from a terminal, or use one of the other modes.";
      const box = containerEl.createDiv({ cls: "cc-conn-status" });
      box.toggleClass("is-ok", found);
      box.toggleClass("is-err", !found);
      box.setText((found ? "✓ " : "✗ ") + detail);
    }

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Optional. Point at a gateway/proxy instead of api.anthropic.com. Leave blank for the default.")
      .addText((text) => {
        text.inputEl.setCssStyles({ width: "320px" });
        text
          .setPlaceholder("https://api.anthropic.com")
          .setValue(s.baseUrl)
          .onChange(async (v) => {
            s.baseUrl = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // Save & Test connection — confirms settings saved and the credential works.
    const claudeStatus = containerEl.createDiv({ cls: "cc-conn-status" });
    new Setting(containerEl)
      .setName("Save & test connection")
      .setDesc("Saves settings and sends a tiny request to verify your credential.")
      .addButton((btn) =>
        btn
          .setButtonText("Save & test")
          .setCta()
          .onClick(async () => {
            await this.plugin.saveSettings();
            this.renderStatus(claudeStatus, { ok: true, detail: "Testing…" });
            const status = await this.plugin.router().anthropic.test();
            this.renderStatus(claudeStatus, status);
            // Prompts held back while there was no credential can run now.
            if (status.ok) await this.plugin.runFirstRunPrompts();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Pick a default model. A custom id below overrides this.")
      .addDropdown((dd) => {
        for (const m of CLAUDE_MODELS) dd.addOption(m.id, m.label);
        dd.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Custom model id")
      .setDesc("Optional. Overrides the dropdown — useful for new or dated model snapshots.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. claude-sonnet-4-6-20250930")
          .setValue(this.plugin.settings.customModel)
          .onChange(async (v) => {
            this.plugin.settings.customModel = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName("Chat backend")
      .setDesc("Where chat runs. Auto keeps using Claude but transparently falls back to your local model when Claude is offline or out of usage — so you never lose chat on a plane or when tokens run out.")
      .addDropdown((dd) => {
        dd.addOption("claude", "Claude only");
        dd.addOption("auto", "Auto (Claude, fall back to local)");
        dd.addOption("local", "Local only — Ollama (offline)");
        dd.addOption("custom", "Local only — OpenAI-compatible endpoint");
        dd.setValue(this.plugin.settings.chatBackend).onChange(async (v) => {
          this.plugin.settings.chatBackend = v as PluginSettings["chatBackend"];
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Max response tokens")
      .setDesc("Upper bound on a single reply (cap 64000). Higher values leave less context-window room.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          const valid = Number.isFinite(n) && n > 0;
          text.inputEl.toggleClass("cc-input-invalid", !valid);
          if (!valid) return;
          const clamped = Math.min(n, 64000);
          if (clamped !== n) text.setValue(String(clamped));
          this.plugin.settings.maxTokens = clamped;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Behavior").setHeading();

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Prepended to every conversation. The artifact design system is always appended automatically.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 5;
        ta.inputEl.setCssStyles({ width: "100%" });
        ta.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Context character budget")
      .setDesc("Max characters of vault context attached to a request.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.contextCharBudget)).onChange(async (v) => {
          const n = parseInt(v, 10);
          const valid = Number.isFinite(n) && n > 0;
          text.inputEl.toggleClass("cc-input-invalid", !valid);
          if (!valid) return;
          this.plugin.settings.contextCharBudget = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max context notes")
      .setDesc("How many linked / search-matched notes to include.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxContextNotes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          const valid = Number.isFinite(n) && n >= 0;
          text.inputEl.toggleClass("cc-input-invalid", !valid);
          if (!valid) return;
          this.plugin.settings.maxContextNotes = n;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderStorageSection(containerEl: HTMLElement): void {
    // "Open in browser" shells out to the OS — desktop only. On mobile the
    // setting can never take effect, so don't offer it.
    if (!Platform.isMobile) {
      new Setting(containerEl)
        .setName("Open artifacts in")
        .setDesc("Where the “Open” button on an artifact sends it. Keeping it in Obsidian is tidiest; choose a browser to pop it out.")
        .addDropdown((dd) => {
          dd.addOption("obsidian", "Obsidian (in-app, full screen)");
          dd.addOption("default", "System default browser");
          dd.addOption("chrome", "Google Chrome");
          dd.addOption("safari", "Safari");
          dd.addOption("brave", "Brave");
          dd.addOption("firefox", "Firefox");
          dd.setValue(this.plugin.settings.artifactOpenTarget).onChange(async (v) => {
            this.plugin.settings.artifactOpenTarget = v as typeof this.plugin.settings.artifactOpenTarget;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Artifacts folder")
      .setDesc("Where saved artifacts (interactive HTML notes) are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.artifactFolder).onChange(async (v) => {
          this.plugin.settings.artifactFolder = v.trim() || "Claude/Artifacts";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Chats folder")
      .setDesc("Where saved chat transcripts are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.chatFolder).onChange(async (v) => {
          this.plugin.settings.chatFolder = v.trim() || "Claude/Chats";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Plans folder")
      .setDesc("Where saved plan notes (artifact + Build-task checklist) are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.planFolder).onChange(async (v) => {
          this.plugin.settings.planFolder = v.trim() || "Claude/Plans";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Templates folder")
      .setDesc("Markdown notes here become your own slash commands in chat (frontmatter: name, description, optional model/context).")
      .addText((text) =>
        text.setValue(this.plugin.settings.templatesFolder).onChange(async (v) => {
          this.plugin.settings.templatesFolder = v.trim() || "Claude/Templates";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Inline artifact height")
      .setDesc("Default pixel height for artifacts rendered inside notes.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.artifactHeight)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.artifactHeight = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Conversation history limit")
      .setDesc("How many past chats to keep (oldest are pruned). Use 0 for unlimited.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxConversations)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.maxConversations = n;
            await this.plugin.saveSettings();
          }
        }),
      );
  }

  private renderLocalModelsSection(containerEl: HTMLElement, rerender: () => void): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Run cheap, bulk work — summarizing, tagging, ingestion — on a local model to save Anthropic tokens. Chat and plans still use Claude unless you route them here.",
    });

    new Setting(containerEl)
      .setName("Utility tasks backend")
      .setDesc("Summaries, auto-tagging, and ingestion go to this backend instead of Claude.")
      .addDropdown((dd) => {
        dd.addOption("claude", "Claude");
        dd.addOption("ollama", "Ollama (local)");
        dd.addOption("custom", "OpenAI-compatible endpoint");
        dd.setValue(this.plugin.settings.utilityBackend).onChange(async (v) => {
          this.plugin.settings.utilityBackend = v as PluginSettings["utilityBackend"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Ollama").setHeading();

    new Setting(containerEl)
      .setName("Ollama host")
      .setDesc("Base URL of your local Ollama server.")
      .addText((text) =>
        text.setValue(this.plugin.settings.ollamaHost).onChange(async (v) => {
          this.plugin.settings.ollamaHost = v.trim() || "http://localhost:11434";
          await this.plugin.saveSettings();
        }),
      );

    // Local model: a dropdown auto-populated from the Ollama server when
    // models have been detected, otherwise a free-text field.
    const modelSetting = new Setting(containerEl)
      .setName("Local chat model")
      .setDesc("Choose a detected model, or type one (e.g. llama3.1, qwen2.5). Click Detect to refresh the list.");

    const detected = this.detectedOllamaModels;
    if (detected && detected.length > 0) {
      modelSetting.addDropdown((dd) => {
        for (const m of detected) dd.addOption(m, m);
        // Keep the current value selectable even if not in the detected list.
        if (!detected.includes(this.plugin.settings.ollamaModel)) dd.addOption(this.plugin.settings.ollamaModel, `${this.plugin.settings.ollamaModel} (current)`);
        dd.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
          this.plugin.settings.ollamaModel = v;
          await this.plugin.saveSettings();
        });
      });
    } else {
      modelSetting.addText((text) =>
        text.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
          this.plugin.settings.ollamaModel = v.trim() || "llama3.1";
          await this.plugin.saveSettings();
        }),
      );
    }
    modelSetting.addButton((btn) =>
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
          rerender(); // re-render this accordion so the dropdown appears/updates
        }),
    );

    // Capability badges per detected model — tools gates the agent; thinking
    // means the model reasons before answering (shows in the chat indicator).
    const capsEl = containerEl.createDiv({ cls: "cc-model-caps setting-item-description" });
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

    const ollamaStatus = containerEl.createDiv({ cls: "cc-conn-status" });
    new Setting(containerEl)
      .setName("Test local connection")
      .setDesc("Checks that Ollama is reachable and lists pulled models.")
      .addButton((btn) =>
        btn.setButtonText("Test Ollama").onClick(async () => {
          await this.plugin.saveSettings();
          this.renderStatus(ollamaStatus, { ok: true, detail: "Testing…" });
          this.renderStatus(ollamaStatus, await this.plugin.router().ollama.test());
        }),
      );

    new Setting(containerEl)
      .setName("Utility model (optional)")
      .setDesc("A smaller model for utility tasks (tagging, summaries, ingestion). Empty = use the chat model above. A 1–3B model is plenty and much faster.")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.settings.ollamaModel)
          .setValue(this.plugin.settings.ollamaUtilityModel)
          .onChange(async (v) => {
            this.plugin.settings.ollamaUtilityModel = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("OpenAI-compatible endpoint").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Point at LM Studio, mlx-lm, vLLM, Jan, or Ollama's /v1 mode — including Apple-silicon-optimized servers like `mlx_lm.server`. Select it as the chat backend or utility backend above, and as an embedding engine under Semantic search.",
    });

    new Setting(containerEl)
      .setName("Endpoint host")
      .setDesc("Base URL, with or without /v1 (e.g. http://localhost:1234).")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:1234")
          .setValue(this.plugin.settings.openaiCompatHost)
          .onChange(async (v) => {
            this.plugin.settings.openaiCompatHost = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Endpoint model")
      .setDesc("The model id the server exposes (see Test / its model list).")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiCompatModel).onChange(async (v) => {
          this.plugin.settings.openaiCompatModel = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Endpoint API key")
      .setDesc("Optional. Most local servers accept anything or nothing.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.openaiCompatKey).onChange(async (v) => {
          this.plugin.settings.openaiCompatKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    const customStatus = containerEl.createDiv({ cls: "cc-conn-status" });
    new Setting(containerEl)
      .setName("Test endpoint")
      .setDesc("Checks the endpoint is reachable and lists its models.")
      .addButton((btn) =>
        btn.setButtonText("Test endpoint").onClick(async () => {
          await this.plugin.saveSettings();
          this.renderStatus(customStatus, { ok: true, detail: "Testing…" });
          this.renderStatus(customStatus, await this.plugin.router().openaiCompat.test());
        }),
      );
  }

  private renderDiscoverySection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Research intelligence narrator")
      .setDesc("Choose the provider used only when you click Analyze in a Research Intelligence view. Deterministic findings stay local and always remain available.")
      .addDropdown((dd) => {
        dd.addOption("current", "Current chat backend");
        dd.addOption("claude", "Claude only");
        dd.addOption("local", "Local only");
        dd.addOption("disabled", "Disabled");
        dd.setValue(this.plugin.settings.intelligenceNarrator).onChange(async (value) => {
          this.plugin.settings.intelligenceNarrator = value as PluginSettings["intelligenceNarrator"];
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Network requests happen only when you explicitly run a discovery action. Results are derived suggestions, and imported sources remain unreviewed until you review them.",
    });

    new Setting(containerEl)
      .setName("Enable scholarly discovery")
      .setDesc("Show explicit search, citation expansion, and reranking actions in research projects.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.discoveryEnabled).onChange(async (value) => {
        this.plugin.settings.discoveryEnabled = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("OpenAlex contact email")
      .setDesc("Optional. Included as a trimmed mailto parameter in OpenAlex requests.")
      .addText((text) => text.setValue(this.plugin.settings.openAlexContactEmail).onChange(async (value) => {
        this.plugin.settings.openAlexContactEmail = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Zotero user id")
      .setDesc("Optional. Numeric user id from zotero.org/settings/keys — lets research_source_import resolve a zotero_key into full metadata. Requests fire only on an explicit import.")
      .addText((text) => text.setValue(this.plugin.settings.zoteroUserId).onChange(async (value) => {
        this.plugin.settings.zoteroUserId = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Zotero API key")
      .setDesc("Optional. Required for private libraries; a public library resolves without one.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.zoteroApiKey).onChange(async (value) => {
          this.plugin.settings.zoteroApiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Discovery reranker")
      .setDesc("Provider used only when you explicitly rerank derived discovery results.")
      .addDropdown((dropdown) => {
        dropdown.addOption("current", "Current chat backend");
        dropdown.addOption("claude", "Claude only");
        dropdown.addOption("local", "Local only");
        dropdown.addOption("disabled", "Disabled");
        dropdown.setValue(this.plugin.settings.discoveryReranker).onChange(async (value) => {
          this.plugin.settings.discoveryReranker = value as PluginSettings["discoveryReranker"];
          await this.plugin.saveSettings();
        });
      });

    const numberSetting = (name: string, description: string, key: "discoveryMaxResults" | "discoveryExpansionLimit" | "discoveryCacheHours") => {
      new Setting(containerEl).setName(name).setDesc(description).addText((text) =>
        text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
          const parsed = Number(value);
          Object.assign(this.plugin.settings, normalizeDiscoverySettings({ ...this.plugin.settings, [key]: parsed }));
          await this.plugin.saveSettings();
        }));
    };
    numberSetting("Maximum search results", "Per request, from 5 to 100.", "discoveryMaxResults");
    numberSetting("Citation expansion limit", "Per expansion request, from 5 to 50.", "discoveryExpansionLimit");
    numberSetting("Derived cache lifetime", "Hours to retain derived discovery results, from 1 to 168.", "discoveryCacheHours");

    new Setting(containerEl)
      .setName("Clear discovery cache")
      .setDesc("Deletes derived discovery state only. It does not write to or delete vault notes.")
      .addButton((button) => button.setButtonText("Clear cache").onClick(() => {
        this.plugin.clearDiscoveryCache();
        new Notice("Discovery cache cleared.");
      }));
  }

  private renderSemanticSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable semantic search")
      .setDesc("Build a local vector index so the vault is searchable by meaning, not just keywords. Private and on-device. Powers the “Search vault” context and Ask-your-vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.semanticEnabled).onChange(async (v) => {
          this.plugin.settings.semanticEnabled = v;
          await this.plugin.saveSettings();
          // Re-render only this section — a full renderSettings() would collapse
          // the accordion and throw the user back to the top of the tab.
          containerEl.empty();
          this.renderSemanticSection(containerEl);
        }),
      );

    if (this.plugin.settings.semanticEnabled) {
      new Setting(containerEl)
        .setName("Embedding engine")
        .setDesc("Built-in runs a small model inside Obsidian on every platform (one-time download). Ollama uses your local Ollama server (desktop). Endpoint uses the OpenAI-compatible server from Local models.")
        .addDropdown((dd) => {
          dd.addOption("builtin", "Built-in (recommended)");
          dd.addOption("ollama", "Ollama");
          dd.addOption("custom", "OpenAI-compatible endpoint");
          dd.setValue(this.plugin.settings.embeddingEngine).onChange(async (v) => {
            if (v === this.plugin.settings.embeddingEngine) return;
            const hadNotes = ((await this.plugin.indexer()?.stats().catch(() => null))?.notes ?? 0) > 0;
            this.plugin.settings.embeddingEngine = v as PluginSettings["embeddingEngine"];
            await this.plugin.saveSettings();
            this.plugin.invalidateIndexer();
            containerEl.empty();
            this.renderSemanticSection(containerEl);
            if (hadNotes) this.offerIndexRebuild(v === "builtin" ? "the built-in model" : v);
          });
        });

      if (this.plugin.settings.embeddingEngine === "builtin") {
        new Setting(containerEl)
          .setName("Built-in model")
          .setDesc("Larger models index more accurately at a slower speed and bigger download. Switching rebuilds the index.")
          .addDropdown((dd) => {
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
              containerEl.empty();
              this.renderSemanticSection(containerEl);
              if (hadNotes) this.offerIndexRebuild(label);
            });
          });

        const model = builtinModelById(this.plugin.settings.builtinEmbeddingModel);
        const status = containerEl.createDiv({ cls: "cc-conn-status setting-item-description" });
        const backend = this.plugin.builtinEmbedder().backend();
        status.setText(backend ? `Model ready · ${backend === "webgpu" ? "WebGPU" : "WASM"}` : "Model not downloaded yet.");

        let mainBtn: ButtonComponent | null = null;
        let clearBtn: ButtonComponent | null = null;
        new Setting(containerEl)
          .setName("Embedding model")
          .setDesc(`${model.hfRepo} (~${model.approxDownloadMB} MB from huggingface.co + ~23 MB ONNX runtime from cdn.jsdelivr.net, one-time; cached and fully on-device afterwards).`)
          .addButton((btn) => {
            // Non-CTA: delete the downloaded model from the local cache. Hidden
            // until we know there is something to clear (loaded or cached).
            clearBtn = btn;
            btn.setButtonText("Clear").onClick(async () => {
              btn.setDisabled(true);
              await this.plugin.clearBuiltinModel();
              containerEl.empty(); // status returns to "Model not downloaded yet."
              this.renderSemanticSection(containerEl);
            });
            if (!backend) btn.buttonEl.hide();
          })
          .addButton((btn) => {
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
      }

      if (this.plugin.settings.embeddingEngine === "ollama") {
        new Setting(containerEl)
          .setName("Embedding model")
          .setDesc("An Ollama embedding model. Pull one first, e.g. `ollama pull nomic-embed-text`.")
          .addDropdown((dd) => {
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
      }

      if (this.plugin.settings.embeddingEngine === "custom") {
        new Setting(containerEl)
          .setName("Endpoint embedding model")
          .setDesc("An embedding model id on the OpenAI-compatible endpoint (configured under Local models), e.g. text-embedding-nomic-embed-text-v1.5.")
          .addText((text) =>
            text.setValue(this.plugin.settings.openaiCompatEmbeddingModel).onChange(async (v) => {
              this.plugin.settings.openaiCompatEmbeddingModel = v.trim();
              await this.plugin.saveSettings();
              this.plugin.invalidateIndexer();
            }),
          );
      }

      const idxStatus = containerEl.createDiv({ cls: "cc-conn-status setting-item-description" });
      void this.plugin
        .indexer()
        ?.stats()
        .then((s) => idxStatus.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`))
        .catch(() => idxStatus.setText("Index: not built yet."));

      new Setting(containerEl)
        .setName("Index PDF text")
        .setDesc("Extract text from vault PDFs into the semantic index (page numbers kept, so results cite the page). Rebuilds the index on the next save or manual rebuild.")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.semanticIndexPdfs).onChange(async (v) => {
            this.plugin.settings.semanticIndexPdfs = v;
            await this.plugin.saveSettings();
            this.plugin.invalidateIndexer();
          }),
        );

      new Setting(containerEl)
        .setName("Rebuild index")
        .setDesc("Embed every note now. Re-embeds only changed notes on save afterward.")
        .addButton((btn) =>
          btn
            .setButtonText("Rebuild")
            .setCta()
            .onClick(async () => {
              await this.plugin.rebuildSemanticIndex();
              const s = await this.plugin.indexer()?.stats();
              if (s) idxStatus.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`);
            }),
        );
    }

  }

  private renderIndexingSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Auto-tag on save")
      .setDesc("When saving an artifact or chat, generate topic tags + a one-line summary (uses the utility provider above) so notes are indexed correctly.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoTagOnSave).onChange(async (v) => {
          this.plugin.settings.autoTagOnSave = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Artifact base tags")
      .setDesc("Comma-separated tags every saved artifact gets (for reliable filtering).")
      .addText((text) =>
        text.setValue(this.plugin.settings.artifactBaseTags.join(", ")).onChange(async (v) => {
          this.plugin.settings.artifactBaseTags = splitTags(v);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Chat base tags")
      .setDesc("Comma-separated tags every saved chat gets.")
      .addText((text) =>
        text.setValue(this.plugin.settings.chatBaseTags.join(", ")).onChange(async (v) => {
          this.plugin.settings.chatBaseTags = splitTags(v);
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderMemorySection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Capture Claude Code CLI sessions for this vault into sanitized digest notes. Desktop-only; sessions are matched by the directory you ran Claude Code in.",
    });

    new Setting(containerEl)
      .setName("Enable session memory")
      .setDesc("Show the capture command, the “ingest” checkbox, and the memory sidebar.")
      .addToggle((t) =>
        t.setValue(s.memoryEnabled).onChange(async (v) => {
          s.memoryEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Memory folder")
      .setDesc("Where session digest notes are written.")
      .addText((text) =>
        text
          .setPlaceholder("Claude/Sessions")
          .setValue(s.memoryFolder)
          .onChange(async (v) => {
            s.memoryFolder = v.trim() || "Claude/Sessions";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Ingest on save (default)")
      .setDesc("Default state of the “ingest” checkbox next to Save in the chat view.")
      .addToggle((t) =>
        t.setValue(s.memoryIngestOnSave).onChange(async (v) => {
          s.memoryIngestOnSave = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-consolidate memory")
      .setDesc("After each capture, merge recent digests into the “What Claude Knows” note (uses the utility model — local when enabled).")
      .addToggle((t) =>
        t.setValue(s.memoryAutoConsolidate).onChange(async (v) => {
          s.memoryAutoConsolidate = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderSourceCaptureSection(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Point the Obsidian Web Clipper (and dropped CSVs) at an inbox folder; Companion types each new file into a schema-validated source note. Extraction uses your utility model (local if enabled).",
    });

    new Setting(containerEl)
      .setName("Enable source capture")
      .setDesc("Master switch for watching the inbox and the 'Enrich note as source' command.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sourceCaptureEnabled).onChange(async (v) => {
          this.plugin.settings.sourceCaptureEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-enrich on create")
      .setDesc("Type files automatically as they appear in the inbox (otherwise use the command).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sourceEnrichOnCreate).onChange(async (v) => {
          this.plugin.settings.sourceEnrichOnCreate = v;
          // Re-enabling here is explicit consent to send inbox files to the utility model.
          if (v) this.plugin.settings.sourceCaptureConsent = "allow";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Inbox folder")
      .setDesc("Folder the Web Clipper writes to and Companion watches.")
      .addText((text) =>
        text.setValue(this.plugin.settings.sourceInboxFolder).onChange(async (v) => {
          this.plugin.settings.sourceInboxFolder = v.trim() || "Clippings";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Organized folder")
      .setDesc("Where “Organize clippings” moves reviewed clips — one subfolder per inferred topic/project.")
      .addText((text) =>
        text.setValue(this.plugin.settings.clipOrganizedFolder).onChange(async (v) => {
          this.plugin.settings.clipOrganizedFolder = v.trim() || "Library";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Base tags")
      .setDesc("Comma-separated tags added to every enriched source note.")
      .addText((text) =>
        text.setValue(this.plugin.settings.sourceBaseTags.join(", ")).onChange(async (v) => {
          this.plugin.settings.sourceBaseTags = v.split(",").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }),
      );

    const templateStatus = containerEl.createDiv({ cls: "cc-conn-status setting-item-description" });
    const exported = this.plugin.settings.clipperTemplateFingerprint !== "";
    if (exported) {
      const stale = this.plugin.clipperTemplatesStale();
      templateStatus.setText(stale ? "✗ Templates out of date — schemas or inbox changed since export." : "✓ Templates current with your schemas.");
      templateStatus.toggleClass("is-err", stale);
      templateStatus.toggleClass("is-ok", !stale);
    }
    new Setting(containerEl)
      .setName("Web Clipper templates")
      .setDesc("Write clipper templates matching these schemas into the vault. Import them in the Web Clipper extension and clips arrive already typed — enrichment then only fills what the page couldn't say.")
      .addButton((b) =>
        b.setButtonText("Export templates").onClick(async () => {
          await this.plugin.exportClipperTemplates();
          templateStatus.setText("✓ Templates current with your schemas.");
          templateStatus.toggleClass("is-err", false);
          templateStatus.toggleClass("is-ok", true);
        }),
      );
  }

  private renderOntologySection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable ontology")
      .setDesc("Claude writes typed frontmatter and wikilink relations that conform to schema notes in your vault. Run “Seed ontology” to create the default schemas.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.ontologyEnabled).onChange(async (v) => {
          this.plugin.settings.ontologyEnabled = v;
          await this.plugin.saveSettings();
          // Turning it on here is an explicit ask, so the seed offer follows
          // regardless of credential — the gate is a startup ordering rule.
          if (v) void this.plugin.loadOntologyOnStart().then(() => this.plugin.offerOntologySeed());
        }),
      );

    new Setting(containerEl)
      .setName("Ontology folder")
      .setDesc("Where the schema notes live (one note per type). Edit those notes to change the schema.")
      .addText((text) =>
        text.setValue(this.plugin.settings.ontologyFolder).onChange(async (v) => {
          this.plugin.settings.ontologyFolder = v.trim() || "Ontology";
          await this.plugin.saveSettings();
          void this.plugin.ontology()?.load();
        }),
      );
  }

  private renderAgentSection(containerEl: HTMLElement, rerender: () => void): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "One agent, three surfaces. In chat (here): Claude searches, reads, and — with writes on — edits your vault, asking before every write. " +
        "On desktop, Claude Code uses the official Obsidian CLI by default; the optional bridge below serves Claude Desktop and advanced live-vault clients. " +
        "On mobile, a Cloud session (next section) works your vault's Git repo and writes replies back. Same vault, same guardrails, wherever you are.",
    });

    new Setting(containerEl)
      .setName("Let Claude use vault tools")
      .setDesc("Claude can search and read your notes on its own while answering (read-only). Turn off for plain chat with pre-attached context.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.agentModeEnabled).onChange(async (v) => {
          this.plugin.settings.agentModeEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Allow write tools")
      .setDesc("Also let Claude create, edit, and move notes from chat. Every write asks for your confirmation first.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.agentAllowWrites).onChange(async (v) => {
          this.plugin.settings.agentAllowWrites = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max tool iterations per turn")
      .setDesc("How many search/read/write rounds Claude may take before it must answer.")
      .addSlider((s) =>
        s
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.agentMaxIterations)
          .onChange(async (v) => {
            this.plugin.settings.agentMaxIterations = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Web search tool")
      .setDesc("Let Claude search the public web from chat (explicit searches only — nothing fires in the background).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.webSearchEnabled).onChange(async (v) => {
          this.plugin.settings.webSearchEnabled = v;
          await this.plugin.saveSettings();
          rerender(); // show/hide the engine dropdown in place
        }),
      );

    if (this.plugin.settings.webSearchEnabled) {
      new Setting(containerEl)
        .setName("Search engine")
        .setDesc("DuckDuckGo needs no key; Brave gives higher-quality results with an API key.")
        .addDropdown((dd) => {
          dd.addOption("duckduckgo", "DuckDuckGo (no key)");
          dd.addOption("brave", "Brave Search (API key)");
          dd.setValue(this.plugin.settings.webSearchEngine).onChange(async (v) => {
            this.plugin.settings.webSearchEngine = v as "duckduckgo" | "brave";
            await this.plugin.saveSettings();
            rerender(); // show/hide the Brave key field in place
          });
        });

      if (this.plugin.settings.webSearchEngine === "brave") {
        new Setting(containerEl)
          .setName("Brave Search API key")
          .setDesc(`Subscription token from brave.com/search/api. ${this.storageBlurb()}`)
          .addText((text) => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.settings.braveSearchApiKey).onChange(async (v) => {
              this.plugin.settings.braveSearchApiKey = v.trim();
              await this.plugin.saveSettings();
            });
          });
      }
    }

    new Setting(containerEl)
      .setName("Web fetch tool")
      .setDesc("Let Claude read a public web page as clean markdown — after a search, or a URL you give it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.webFetchEnabled).onChange(async (v) => {
          this.plugin.settings.webFetchEnabled = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderMcpClientSection(containerEl: HTMLElement, rerender: () => void): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Let the in-chat agent use tools from external MCP servers — Companion can serve its vault through the optional desktop bridge and consume other servers here. " +
        "Every external tool call asks for your confirmation. HTTP servers work on mobile; stdio commands run on desktop only.",
    });

    s.mcpClientServers.forEach((server, index) => {
      const box = containerEl.createDiv({ cls: "cc-mcp-server" });
      new Setting(box)
        .setName(server.name.trim() || `Server ${index + 1}`)
        .setDesc(`${server.transport === "http" ? "HTTP" : "stdio (desktop)"}${server.enabled ? "" : " · disabled"}`)
        .addToggle((t) =>
          t.setValue(server.enabled).onChange(async (v) => {
            server.enabled = v;
            await this.plugin.saveSettings();
            rerender();
          }),
        )
        .addButton((b) =>
          b.setButtonText("Remove").onClick(async () => {
            s.mcpClientServers.splice(index, 1);
            await this.plugin.saveSettings();
            rerender();
          }),
        );

      new Setting(box)
        .setName("Name")
        .addText((text) =>
          text.setValue(server.name).onChange(async (v) => {
            server.name = v;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(box)
        .setName("Transport")
        .addDropdown((dd) => {
          dd.addOption("http", "HTTP (streamable)");
          dd.addOption("stdio", "stdio command (desktop)");
          dd.setValue(server.transport).onChange(async (v) => {
            server.transport = v as McpServerConfig["transport"];
            await this.plugin.saveSettings();
            rerender();
          });
        });

      if (server.transport === "http") {
        new Setting(box)
          .setName("Server URL")
          .addText((text) => {
            text.inputEl.setCssStyles({ width: "320px" });
            text.setPlaceholder("https://example.test/mcp").setValue(server.url).onChange(async (v) => {
              server.url = v.trim();
              await this.plugin.saveSettings();
            });
          });
      } else {
        new Setting(box)
          .setName("Command")
          .addText((text) => {
            text.inputEl.setCssStyles({ width: "240px" });
            text.setPlaceholder("npx").setValue(server.command).onChange(async (v) => {
              server.command = v.trim();
              await this.plugin.saveSettings();
            });
          });
        new Setting(box)
          .setName("Arguments")
          .addText((text) => {
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
    });

    new Setting(containerEl)
      .setName("Add server")
      .addButton((b) =>
        b.setButtonText("Add MCP server").setCta().onClick(async () => {
          s.mcpClientServers.push({ name: "", enabled: true, transport: "http", url: "", command: "", args: "" });
          await this.plugin.saveSettings();
          rerender();
        }),
      );
  }

  private renderCloudSection(containerEl: HTMLElement, rerender: () => void): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Dispatch a Claude Code session in the cloud to work your vault's Git repo and report back — so you can cowork with Claude from a phone, where the local bridge can't run. " +
        "The Routines API is experimental; if Anthropic ships a newer beta revision, update the header below.",
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "In the Claude Code web UI, create a routine pointed at your vault's Git repo, then complete the checklist below.",
    });
    const checklistEl = containerEl.createDiv({ cls: "cc-setup-checklist" });
    const renderChecklist = (): void => {
      checklistEl.empty();
      const steps = dispatchSetupSteps({ fireUrl: s.cloudRoutineFireUrl, token: s.cloudRoutineToken, betaHeader: s.cloudRoutineBetaHeader });
      for (const item of steps) {
        const row = checklistEl.createDiv({ cls: `cc-setup-step ${item.ok ? "is-ok" : "is-err"}` });
        row.createSpan({ cls: "cc-setup-mark", text: item.ok ? "✓" : "✗" });
        row.createSpan({ text: item.detail && !item.ok ? `${item.label} — ${item.detail}` : item.label });
      }
      if (steps.every((item) => item.ok)) {
        checklistEl.createDiv({ cls: "cc-setup-step is-ok", text: "✓ Ready — run “Send to cloud Claude session” from the command palette." });
      }
    };
    renderChecklist();

    new Setting(containerEl)
      .setName("Enable cloud dispatch")
      .setDesc("Adds a “Send to cloud Claude session” command.")
      .addToggle((t) =>
        t.setValue(s.cloudDispatchEnabled).onChange(async (v) => {
          s.cloudDispatchEnabled = v;
          await this.plugin.saveSettings();
          rerender(); // show/hide the routine fields in place
        }),
      );

    if (!s.cloudDispatchEnabled) return;

    new Setting(containerEl)
      .setName("Routine fire URL")
      .setDesc("The routine's “fire” endpoint from the Claude Code web UI (…/v1/claude_code/routines/<id>/fire).")
      .addText((text) => {
        text.inputEl.setCssStyles({ width: "360px" });
        text
          .setPlaceholder("https://api.anthropic.com/v1/claude_code/routines/…/fire")
          .setValue(s.cloudRoutineFireUrl)
          .onChange(async (v) => {
            s.cloudRoutineFireUrl = v.trim();
            await this.plugin.saveSettings();
            renderChecklist();
          });
      });

    new Setting(containerEl)
      .setName("Routine token")
      .setDesc(`Per-routine bearer token (sk-ant-oat…). It only fires this one routine — no account access. ${this.storageBlurb()}`)
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.setCssStyles({ width: "320px" });
        text
          .setPlaceholder("sk-ant-oat…")
          .setValue(s.cloudRoutineToken)
          .onChange(async (v) => {
            s.cloudRoutineToken = v.trim();
            await this.plugin.saveSettings();
            renderChecklist();
          });
      });

    new Setting(containerEl)
      .setName("API beta header")
      .setDesc("anthropic-beta header gating the experimental Routines API. Update if Anthropic ships a newer dated version.")
      .addText((text) => {
        text.inputEl.setCssStyles({ width: "320px" });
        text.setValue(s.cloudRoutineBetaHeader).onChange(async (v) => {
          s.cloudRoutineBetaHeader = v.trim();
          await this.plugin.saveSettings();
          renderChecklist();
        });
      });

    const warn = containerEl.createEl("p", { cls: "setting-item-description" });
    warn.setCssStyles({ color: "var(--text-warning)" });
    warn.setText(
      "⚠️ Unlike the local bridge, this sends your prompt + attached note context to Anthropic's cloud and runs against your vault's Git repo. " +
        `${this.storageBlurb()} Use a private repo.`,
    );
  }

  private renderRepliesSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Pull notes a cloud session wrote back into your vault's GitHub repo — over HTTPS, so it works on a phone with no local git. " +
        "Point this at the repo, branch, and folder the session writes replies to.",
    });

    const checklistEl = containerEl.createDiv({ cls: "cc-setup-checklist" });
    const renderChecklist = (): void => {
      checklistEl.empty();
      for (const item of repliesSetupSteps({ repo: s.cloudReplyRepo, branch: s.cloudReplyBranch, folder: s.cloudReplyFolder, token: s.cloudReplyToken })) {
        const row = checklistEl.createDiv({ cls: `cc-setup-step ${item.ok ? "is-ok" : "is-err"}` });
        row.createSpan({ cls: "cc-setup-mark", text: item.ok ? "✓" : "✗" });
        row.createSpan({ text: item.detail && !item.ok ? `${item.label} — ${item.detail}` : item.label });
      }
    };
    renderChecklist();

    new Setting(containerEl)
      .setName("Vault repo")
      .setDesc("owner/name of the GitHub repo backing your vault.")
      .addText((text) => {
        text.inputEl.setCssStyles({ width: "280px" });
        text
          .setPlaceholder("owner/name")
          .setValue(s.cloudReplyRepo)
          .onChange(async (v) => {
            s.cloudReplyRepo = v.trim();
            await this.plugin.saveSettings();
            renderChecklist();
          });
      });

    new Setting(containerEl)
      .setName("Replies branch")
      .setDesc("Branch the cloud session writes replies to.")
      .addText((text) =>
        text.setValue(s.cloudReplyBranch).onChange(async (v) => {
          s.cloudReplyBranch = v.trim() || "main";
          await this.plugin.saveSettings();
          renderChecklist();
        }),
      );

    new Setting(containerEl)
      .setName("Replies folder")
      .setDesc("Folder in the repo where reply notes land.")
      .addText((text) =>
        text.setValue(s.cloudReplyFolder).onChange(async (v) => {
          s.cloudReplyFolder = v.trim() || "Claude/Replies";
          await this.plugin.saveSettings();
          renderChecklist();
        }),
      );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(`Fine-grained token with Contents:read on the repo. ${this.storageBlurb()}`)
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.setCssStyles({ width: "min(320px, 100%)" });
        text
          .setPlaceholder("github_pat_… / ghp_…")
          .setValue(s.cloudReplyToken)
          .onChange(async (v) => {
            s.cloudReplyToken = v.trim();
            await this.plugin.saveSettings();
            renderChecklist();
          });
      });

    const testStatus = containerEl.createDiv({ cls: "cc-conn-status" });
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Read the replies folder from GitHub with the current settings — verifies repo, branch, folder, and token in one shot.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          testStatus.toggleClass("is-ok", false);
          testStatus.toggleClass("is-err", false);
          testStatus.setText("Testing…");
          const result = await this.plugin.testCloudReplies();
          testStatus.toggleClass("is-ok", result.ok);
          testStatus.toggleClass("is-err", !result.ok);
          testStatus.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
          button.setDisabled(false);
        }),
      );
  }

  private renderMcpSection(containerEl: HTMLElement, rerender: () => void): void {
    const s = this.plugin.settings;
    if (Platform.isMobile) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "The local MCP bridge runs only on desktop — it needs a local server. On mobile, use the cloud-session features above to cowork with Claude.",
      });
      return;
    }
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Optional advanced bridge for Claude Desktop and live-vault API clients. Claude Code uses the official Obsidian CLI by default and does not need this server. Bound to 127.0.0.1 and protected by a token.",
    });

    const mcpEnv = (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const resolvedMcp = resolveMcpToken(mcpEnv, s.mcpToken);

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc("Runs a local server on the port below. Turn off to stop sharing your vault.")
      .addToggle((t) =>
        t.setValue(s.mcpEnabled).onChange(async (v) => {
          s.mcpEnabled = v;
          // Only mint a stored token when neither the env var nor a stored token exists.
          if (v && !resolvedMcp.token) s.mcpToken = generateToken();
          await this.plugin.saveSettings();
          rerender(); // refresh status + snippets in place
        }),
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Local port for the MCP server (loopback only).")
      .addText((text) =>
        text.setValue(String(s.mcpPort)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0 && n < 65536) {
            s.mcpPort = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    if (resolvedMcp.source === "env") {
      new Setting(containerEl)
        .setName("Access token")
        .setDesc(`✓ Sourced from the $${MCP_TOKEN_ENV} environment variable — not stored in this vault. Unset it to use a stored token instead.`);
    } else {
      new Setting(containerEl)
        .setName("Access token")
        .setDesc(`Required by clients as a bearer token. Keep it secret. Tip: set $${MCP_TOKEN_ENV} to source it from the environment instead of this vault's data.`)
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
            rerender();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Allow writes")
      .setDesc("Let connected clients create and append notes (read & search are always allowed).")
      .addToggle((t) =>
        t.setValue(s.mcpAllowWrites).onChange(async (v) => {
          s.mcpAllowWrites = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Write folder")
      .setDesc("Default folder for notes created via MCP.")
      .addText((text) =>
        text.setValue(s.mcpWriteFolder).onChange(async (v) => {
          s.mcpWriteFolder = v.trim() || "Claude/Inbox";
          await this.plugin.saveSettings();
        }),
      );

    // Live status.
    const status = containerEl.createDiv({ cls: "cc-conn-status" });
    const running = this.plugin.mcpRunning();
    status.toggleClass("is-ok", running && s.mcpEnabled);
    status.toggleClass("is-err", s.mcpEnabled && !running);
    if (!s.mcpEnabled) status.setText("Server disabled.");
    else status.setText(running ? `✓ Running at ${bridgeUrl(s.mcpPort)}` : "✗ Not running — check the port isn't in use.");

    // Connection snippets — display is share-safe (env ref or masked), Copy is real.
    if (s.mcpEnabled && resolvedMcp.source !== "none") {
      const real = { port: s.mcpPort, token: resolvedMcp.token };
      let display: { port: number; token: string };
      if (resolvedMcp.source === "env") {
        display = { port: s.mcpPort, token: mcpTokenEnvRef() }; // expands in the user's shell
      } else {
        display = { port: s.mcpPort, token: this.revealMcpToken ? resolvedMcp.token : maskToken(resolvedMcp.token) };
        new Setting(containerEl)
          .setName("Show token in snippets")
          .setDesc("Off by default so the snippets are safe to screen-share. Copy always copies the real, working command.")
          .addToggle((t) =>
            t.setValue(this.revealMcpToken).onChange((v) => {
              this.revealMcpToken = v;
              rerender();
            }),
          );
      }
      // env-sourced: copy the env-ref command (no secret, works in their shell). stored: copy the real command.
      const copyInfo = resolvedMcp.source === "env" ? display : real;
      this.codeBlock(containerEl, "Advanced Claude Code MCP connection (ordinary use is CLI-first):", claudeCodeCommand(display), claudeCodeCommand(copyInfo));
      this.codeBlock(containerEl, "Claude Desktop (add to claude_desktop_config.json):", claudeDesktopConfig(display), claudeDesktopConfig(copyInfo));
    } else if (s.mcpEnabled) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: `Set an access token (or $${MCP_TOKEN_ENV}) to get connection snippets.`,
      });
    }
  }

  /** A collapsed <details> accordion whose summary is the section title.
   * The render fn receives a `rerender` that rebuilds only this accordion's
   * body in place — the <details> element (and its open state) and the rest
   * of the tab stay put. */
  private accordion(parent: HTMLElement, title: string, render: (body: HTMLElement, rerender: () => void) => void): () => void {
    const details = parent.createEl(Platform.isMobile ? "section" : "details", { cls: "cc-accordion" });
    const summary = details.createEl(Platform.isMobile ? "button" : "summary", {
      cls: "cc-accordion-summary",
      text: title,
      ...(Platform.isMobile ? { attr: { type: "button", "aria-expanded": "false" } } : {}),
    });
    const body = details.createDiv({ cls: "cc-accordion-body" });
    if (Platform.isMobile) {
      body.setAttr("hidden", "");
      summary.addEventListener("click", () => {
        const expanded = summary.getAttribute("aria-expanded") === "true";
        summary.setAttr("aria-expanded", String(!expanded));
        details.toggleClass("is-open", !expanded);
        if (expanded) body.setAttr("hidden", "");
        else body.removeAttribute("hidden");
      });
    }
    const rerender = (): void => {
      body.empty();
      render(body, rerender);
    };
    render(body, rerender);
    return rerender;
  }

  /** A visual divider between accordion groups. */
  private groupHeading(parent: HTMLElement, text: string): void {
    parent.createEl("p", { cls: "cc-settings-group", text });
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

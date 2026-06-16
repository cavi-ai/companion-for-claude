import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCompanionPlugin from "./main";
import { CLAUDE_MODELS } from "./claude/models";
import type { ProviderStatus } from "./providers/types";
import { readAnthropicEnv, hasAnthropicEnvCredential } from "./providers/env";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "./mcp/clientConfig";
import { configError } from "./cloud/routines";
import { configError as repliesConfigError } from "./cloud/replies";

export class ClaudeCompanionSettingTab extends PluginSettingTab {
  /** Cached list of Ollama models from the last Detect, for the dropdown. */
  private detectedOllamaModels: string[] | null = null;
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  private revealMcpToken = false;

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

    // In-app disclosure of what the plugin accesses — mirrors the community-store
    // "Behavior" notes so users see it after install, not just on the store page.
    new Setting(containerEl)
      .setName("What this plugin accesses")
      .setDesc(
        "Your messages and vault context go only to Anthropic (and your local Ollama, if enabled) — nothing else leaves your machine. On desktop, optional features touch files outside the vault: session capture reads Claude Code transcripts from your Claude projects folder, and “open artifact in browser” writes a temporary HTML file. Semantic search reads every note in your vault to build a local index. Copy buttons use the system clipboard. All filesystem access is disabled on mobile.",
      )
      .setHeading();

    new Setting(containerEl).setName("Connection").setHeading();

    const s = this.plugin.settings;

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
          this.renderSettings(); // re-render to show the matching field
        });
      });

    if (s.authMode === "apiKey") {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .setDesc("Bring your own key from console.anthropic.com. Stored locally in this vault's plugin data.")
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
        .setDesc("Stored locally in this vault's plugin data. Sent as a bearer token.")
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
      .setName("Max response tokens")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.maxTokens = Math.min(n, 64000);
            await this.plugin.saveSettings();
          }
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
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.contextCharBudget = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Max context notes")
      .setDesc("How many linked / search-matched notes to include.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxContextNotes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.maxContextNotes = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    this.accordion(containerEl, "Storage", (c) => this.renderStorageSection(c));
    this.accordion(containerEl, "Local models (Ollama)", (c) => this.renderLocalModelsSection(c));
    this.accordion(containerEl, "Semantic search (local embeddings)", (c) => this.renderSemanticSection(c));
    this.accordion(containerEl, "Indexing & tags", (c) => this.renderIndexingSection(c));
    this.accordion(containerEl, "Cloud session (mobile-friendly)", (c) => this.renderCloudSection(c));
    this.accordion(containerEl, "Cloud replies (pull from repo)", (c) => this.renderRepliesSection(c));
    this.accordion(containerEl, "Unified bridge (MCP server)", (c) => this.renderMcpSection(c));
    this.accordion(containerEl, "Session memory", (c) => this.renderMemorySection(c));
  }

  private renderStorageSection(containerEl: HTMLElement): void {
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

  private renderLocalModelsSection(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Run cheap, bulk work — summarizing, tagging, ingestion — on a local model to save Anthropic tokens. Chat and plans still use Claude unless you route them here.",
    });

    new Setting(containerEl)
      .setName("Chat backend")
      .setDesc("Where chat runs. Auto keeps using Claude but transparently falls back to your local model when Claude is offline or out of usage — so you never lose chat on a plane or when tokens run out.")
      .addDropdown((dd) => {
        dd.addOption("claude", "Claude only");
        dd.addOption("auto", "Auto (Claude, fall back to local)");
        dd.addOption("local", "Local only (offline)");
        dd.setValue(this.plugin.settings.chatBackend).onChange(async (v) => {
          this.plugin.settings.chatBackend = v as "claude" | "local" | "auto";
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Use local model for utility tasks")
      .setDesc("Summaries, auto-tagging, and ingestion go to Ollama instead of Claude.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.localUtilityEnabled).onChange(async (v) => {
          this.plugin.settings.localUtilityEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

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
      .setName("Local model")
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
          this.renderSettings(); // re-render so the dropdown appears/updates
        }),
    );

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

  }

  private renderSemanticSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable semantic search")
      .setDesc("Build a local vector index (via Ollama) so the vault is searchable by meaning, not just keywords. Private and offline. Powers the “Search vault” context and Ask-your-vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.semanticEnabled).onChange(async (v) => {
          this.plugin.settings.semanticEnabled = v;
          await this.plugin.saveSettings();
          this.renderSettings();
        }),
      );

    if (this.plugin.settings.semanticEnabled) {
      new Setting(containerEl)
        .setName("Embedding model")
        .setDesc("An Ollama embedding model. Pull one first, e.g. `ollama pull nomic-embed-text`.")
        .addText((text) =>
          text
            .setPlaceholder("nomic-embed-text")
            .setValue(this.plugin.settings.embeddingModel)
            .onChange(async (v) => {
              this.plugin.settings.embeddingModel = v.trim() || "nomic-embed-text";
              await this.plugin.saveSettings();
            }),
        );

      const idxStatus = containerEl.createDiv({ cls: "cc-conn-status setting-item-description" });
      void this.plugin
        .indexer()
        ?.stats()
        .then((s) => idxStatus.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`))
        .catch(() => idxStatus.setText("Index: not built yet."));

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
  }

  private renderCloudSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Dispatch a Claude Code session in the cloud to work your vault's Git repo and report back — so you can cowork with Claude from a phone, where the local bridge can't run. " +
        "Create a routine in the Claude Code web UI, then paste its “fire” URL and token below.",
    });

    new Setting(containerEl)
      .setName("Enable cloud dispatch")
      .setDesc("Adds a “Send to cloud Claude session” command.")
      .addToggle((t) =>
        t.setValue(s.cloudDispatchEnabled).onChange(async (v) => {
          s.cloudDispatchEnabled = v;
          await this.plugin.saveSettings();
          this.renderSettings();
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
          });
      });

    new Setting(containerEl)
      .setName("Routine token")
      .setDesc("Per-routine bearer token (sk-ant-oat…). It only fires this one routine — no account access. Stored locally in this vault's plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.setCssStyles({ width: "320px" });
        text
          .setPlaceholder("sk-ant-oat…")
          .setValue(s.cloudRoutineToken)
          .onChange(async (v) => {
            s.cloudRoutineToken = v.trim();
            await this.plugin.saveSettings();
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
        });
      });

    const warn = containerEl.createEl("p", { cls: "setting-item-description" });
    warn.setCssStyles({ color: "var(--text-warning)" });
    warn.setText(
      "⚠️ Unlike the local bridge, this sends your prompt + attached note context to Anthropic's cloud and runs against your vault's Git repo. " +
        "The token sits in this vault's data.json — if the vault itself syncs, the token syncs too. Use a private repo.",
    );

    const status = containerEl.createDiv({ cls: "cc-conn-status" });
    const err = configError({ fireUrl: s.cloudRoutineFireUrl, token: s.cloudRoutineToken, betaHeader: s.cloudRoutineBetaHeader });
    status.toggleClass("is-ok", !err);
    status.toggleClass("is-err", !!err);
    status.setText(err ? `✗ ${err}` : "✓ Configured — run “Send to cloud Claude session” from the command palette.");
  }

  private renderRepliesSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Pull notes a cloud session wrote back into your vault's GitHub repo — over HTTPS, so it works on a phone with no local git. " +
        "Point this at the repo, branch, and folder the session writes replies to.",
    });

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
          });
      });

    new Setting(containerEl)
      .setName("Replies branch")
      .setDesc("Branch the cloud session writes replies to.")
      .addText((text) =>
        text.setValue(s.cloudReplyBranch).onChange(async (v) => {
          s.cloudReplyBranch = v.trim() || "main";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Replies folder")
      .setDesc("Folder in the repo where reply notes land.")
      .addText((text) =>
        text.setValue(s.cloudReplyFolder).onChange(async (v) => {
          s.cloudReplyFolder = v.trim() || "Claude/Replies";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Fine-grained token with Contents:read on the repo. Stored locally in this vault's plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.setCssStyles({ width: "320px" });
        text
          .setPlaceholder("github_pat_… / ghp_…")
          .setValue(s.cloudReplyToken)
          .onChange(async (v) => {
            s.cloudReplyToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    const status = containerEl.createDiv({ cls: "cc-conn-status" });
    const err = repliesConfigError({ repo: s.cloudReplyRepo, branch: s.cloudReplyBranch, folder: s.cloudReplyFolder, token: s.cloudReplyToken });
    status.toggleClass("is-ok", !err);
    status.toggleClass("is-err", !!err);
    status.setText(err ? `✗ ${err}` : "✓ Configured — run “Pull cloud session replies into the vault”.");
  }

  private renderMcpSection(containerEl: HTMLElement): void {
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
      text: "Expose this vault as a local MCP server so Claude Code and Claude Desktop can search, read, and (optionally) write your notes — unifying all three on one knowledge base. Bound to 127.0.0.1 and protected by a token.",
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
          this.renderSettings(); // refresh status + snippets
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
          text.inputEl.setCssStyles({ width: "260px" });
          text.setValue(s.mcpToken).onChange(async (v) => {
            s.mcpToken = v.trim();
            await this.plugin.saveSettings();
          });
        })
        .addButton((btn) =>
          btn.setButtonText("Regenerate").onClick(async () => {
            s.mcpToken = generateToken();
            await this.plugin.saveSettings();
            this.renderSettings();
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
              this.renderSettings();
            }),
          );
      }
      // env-sourced: copy the env-ref command (no secret, works in their shell). stored: copy the real command.
      const copyInfo = resolvedMcp.source === "env" ? display : real;
      this.codeBlock(containerEl, "Claude Code (run in a terminal):", claudeCodeCommand(display), claudeCodeCommand(copyInfo));
      this.codeBlock(containerEl, "Claude Desktop (add to claude_desktop_config.json):", claudeDesktopConfig(display), claudeDesktopConfig(copyInfo));
    } else if (s.mcpEnabled) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: `Set an access token (or $${MCP_TOKEN_ENV}) to get connection snippets.`,
      });
    }
  }

  /** A collapsed <details> accordion whose summary is the section title. */
  private accordion(parent: HTMLElement, title: string, render: (body: HTMLElement) => void): void {
    const details = parent.createEl("details", { cls: "cc-accordion" });
    details.createEl("summary", { cls: "cc-accordion-summary", text: title });
    render(details.createDiv({ cls: "cc-accordion-body" }));
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
}

function splitTags(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

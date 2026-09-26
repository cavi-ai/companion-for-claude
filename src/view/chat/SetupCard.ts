// First-run card: connect to Claude without leaving the chat panel.

import type ClaudeCompanionPlugin from "../../main";
import type { CliBackend, CliSignInProvider } from "../../cli/backends/types";
import type { ProviderRouter } from "../../providers/router";
import { quickNotice } from "../../notice";

export interface SetupCardDeps {
  plugin: ClaudeCompanionPlugin;
  cliEntries(router: ProviderRouter): { backend: CliBackend; provider: CliSignInProvider }[];
  messagesEl(): HTMLElement;
  hasMessages(): boolean;
  renderEmptyState(): void;
  refreshModelLabel(): void;
  openSettings(): void;
}

export class SetupCard {
  private readonly probeInFlight = new Set<string>();
  /** The card re-renders when a CLI sign-in is detected; a half-typed key survives it. */
  private keyDraft = "";

  constructor(private readonly deps: SetupCardDeps) {}

  render(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "cc-setup-card" });
    const router = this.deps.plugin.router();
    const entries = this.deps.cliEntries(router);
    for (const { backend, provider } of entries) {
      if (!provider.hasCredentials() && provider.available() && !this.probeInFlight.has(backend.id)) {
        this.probeInFlight.add(backend.id);
        void provider.refresh().finally(() => {
          this.probeInFlight.delete(backend.id);
          if (provider.hasCredentials() && this.deps.messagesEl().querySelector(".cc-setup-card")) this.deps.renderEmptyState();
        });
      }
    }
    const signedIn = entries.filter((e) => e.provider.hasCredentials());
    const lead = signedIn[0]?.backend;
    const storage = this.deps.plugin.secrets().available()
      ? "It’s kept in your device’s secret storage, not in this vault — nothing else leaves your machine."
      : "It’s stored in this vault’s plugin data — nothing else leaves your machine.";
    card.createDiv({ cls: "cc-setup-title", text: "Connect to Claude" });
    card.createDiv({
      cls: "cc-setup-sub",
      text: lead
        ? `${lead.label} is signed in on this computer. Use it for chat on your subscription, or add an Anthropic API key. ${storage}`
        : `Add your Anthropic API key to start chatting. ${storage}`,
    });
    if (signedIn.length > 0) {
      const cli = card.createDiv({ cls: "cc-setup-cli" });
      for (const { backend } of signedIn) {
        const useCli = cli.createEl("button", { cls: "mod-cta cc-setup-cli-use", text: `Use ${backend.label} sign-in` });
        useCli.addEventListener("click", () => void (async () => {
          this.deps.plugin.settings.chatBackend = backend.id;
          await this.deps.plugin.saveSettings();
          await this.deps.plugin.continueOnboarding();
          this.deps.renderEmptyState();
          this.deps.refreshModelLabel();
        })());
      }
      card.createDiv({ cls: "cc-setup-or", text: "or" });
    }
    const link = card.createEl("a", {
      cls: "cc-setup-link",
      text: "Get a key at console.anthropic.com",
      href: "https://console.anthropic.com/settings/keys",
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");
    const row = card.createDiv({ cls: "cc-setup-row" });
    const input = row.createEl("input", {
      cls: "cc-setup-input",
      attr: { type: "password", placeholder: "sk-ant-api…", "aria-label": "Anthropic API key" },
    });
    input.value = this.keyDraft;
    input.addEventListener("input", () => { this.keyDraft = input.value; });
    const save = row.createEl("button", { cls: "mod-cta cc-setup-save", text: "Save key" });
    const status = card.createDiv({ cls: "cc-setup-status" });
    save.addEventListener("click", () => void (async () => {
      const key = input.value.trim();
      if (!key) {
        input.focus();
        return;
      }
      this.deps.plugin.settings.authMode = "apiKey";
      this.deps.plugin.settings.apiKey = key;
      await this.deps.plugin.saveSettings(); // rebuilds the provider router
      // Verify here rather than letting the first send be the test — a typo'd
      // key otherwise reads as a broken plugin.
      save.disabled = true;
      status.removeClass("is-err");
      status.setText("Checking your key…");
      const result = await this.deps.plugin.router().anthropic.test();
      save.disabled = false;
      if (!result.ok) {
        // The key stays saved so it can be corrected rather than retyped.
        status.addClass("is-err");
        status.setText(`Couldn’t connect: ${result.detail}`);
        input.focus();
        return;
      }
      status.setText("");
      this.keyDraft = "";
      quickNotice("API key saved — you’re connected.");
      if (!this.deps.hasMessages()) {
        this.deps.messagesEl().empty();
        this.deps.renderEmptyState();
      } else {
        card.remove();
      }
      // Setup held back while there was no credential can run now.
      await this.deps.plugin.continueOnboarding();
    })());
    const settingsBtn = card.createEl("button", { cls: "cc-setup-settings", text: "Other options (OAuth, environment)…" });
    settingsBtn.addEventListener("click", () => this.deps.openSettings());
  }
}

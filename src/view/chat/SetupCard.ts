// First-run card: connect to Claude without leaving the chat panel.

import type { SetupCardHost } from "./hosts";
import type { CliBackend, CliSignInProvider } from "../../cli/backends/types";
import type { ProviderRouter } from "../../providers/router";
import { quickNotice } from "../../notice";

export interface SetupCardDeps {
  plugin: SetupCardHost;
  cliEntries(router: ProviderRouter): { backend: CliBackend; provider: CliSignInProvider }[];
  messagesEl(): HTMLElement;
  hasMessages(): boolean;
  renderEmptyState(): void;
  refreshModelLabel(): void;
  openSettings(): void;
}

export class SetupCard {
  private readonly probeInFlight = new Set<string>();
  /** Preserve a half-typed key across an explicit card remount. */
  private keyDraft = "";
  private submitting = false;
  private refreshConnections: (() => void) | null = null;

  constructor(private readonly deps: SetupCardDeps) {}

  render(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "cc-setup-card" });
    const router = this.deps.plugin.router();
    const entries = this.deps.cliEntries(router);
    const storage = this.deps.plugin.secrets().available()
      ? "The key is kept in device secret storage. Chat sends your message and selected context to the chosen provider."
      : "Secure key storage is unavailable. Use an existing signed-in connection or repair Obsidian secret storage.";
    card.createDiv({ cls: "cc-setup-title", text: "Connect to Claude" });
    const subtitle = card.createDiv({ cls: "cc-setup-sub" });
    const cli = card.createDiv({ cls: "cc-setup-cli" });
    const separator = card.createDiv({ cls: "cc-setup-or", text: "or" });
    const choices = new Map<CliBackend["id"], HTMLButtonElement>();
    const updateConnections = (): void => {
      const signedIn = entries.filter(entry => entry.provider.hasCredentials());
      const lead = signedIn[0]?.backend;
      subtitle.setText(lead
        ? `${lead.label} is signed in on this computer. Use it for chat on your subscription, or add an Anthropic API key. ${storage}`
        : `Add your Anthropic API key to start chatting. ${storage}`);
      const available = new Set(signedIn.map(entry => entry.backend.id));
      for (const [id, button] of choices) {
        if (available.has(id)) continue;
        button.remove();
        choices.delete(id);
      }
      for (const { backend } of signedIn) {
        if (choices.has(backend.id)) continue;
        const useCli = cli.createEl("button", { cls: "mod-cta cc-setup-cli-use", text: `Use ${backend.label} sign-in` });
        useCli.addEventListener("click", () => void this.submit(card, useCli, async () => this.deps.plugin.connection().connect({ backend: backend.id })));
        choices.set(backend.id, useCli);
      }
      cli.toggle(signedIn.length > 0);
      separator.toggle(signedIn.length > 0);
    };
    updateConnections();
    this.refreshConnections = () => {
      if (!this.deps.messagesEl().contains(card)) return;
      updateConnections();
      this.deps.refreshModelLabel();
    };
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
    const save = row.createEl("button", { cls: "mod-cta cc-setup-save", text: "Connect" });
    const status = card.createDiv({ cls: "cc-setup-status" });
    const connect = (): void => {
      if (!input.value.trim()) { input.focus(); return; }
      void this.submit(card, save, () => this.deps.plugin.connection().connect({ backend: "claude", apiKey: input.value }), status);
    };
    save.addEventListener("click", connect);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); connect(); }
    });
    const settingsBtn = card.createEl("button", { cls: "cc-setup-settings", text: "Other connections…" });
    settingsBtn.addEventListener("click", () => this.deps.openSettings());
    for (const { backend, provider } of entries) {
      if (!provider.hasCredentials() && provider.available() && !this.probeInFlight.has(backend.id)) {
        this.probeInFlight.add(backend.id);
        void provider.refresh().catch(() => undefined).finally(() => {
          this.probeInFlight.delete(backend.id);
          if (provider.hasCredentials()) this.refreshConnections?.();
        });
      }
    }
  }
  private async submit(card: HTMLElement, button: HTMLButtonElement, connect: () => Promise<{ ok: boolean; detail: string }>, status = card.createDiv({ cls: "cc-setup-status" })): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    button.disabled = true;
    status.setAttribute("role", "status");
    status.removeClass("is-err");
    status.setText("Connecting…");
    try {
      const result = await connect();
      if (!result.ok) { status.addClass("is-err"); status.setText(result.detail); return; }
      this.keyDraft = "";
      status.setText(result.detail);
      quickNotice(result.detail);
      if (!this.deps.hasMessages()) { this.deps.messagesEl().empty(); this.deps.renderEmptyState(); }
      else card.remove();
      this.deps.refreshModelLabel();
    } catch (error) {
      status.addClass("is-err");
      status.setText(error instanceof Error ? error.message : String(error));
    } finally { this.submitting = false; button.disabled = false; }
  }

}

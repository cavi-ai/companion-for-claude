import { App, Modal } from "obsidian";
import type { DesktopIntegrationViewState } from "../integrations/desktopCoordinator";
import { OBSIDIAN_CLI_UNREACHABLE, obsidianCliInstallHint, type DesktopPlatform, type ProbeResult } from "../integrations/desktop";

export interface DesktopIntegrationsController {
  snapshot(): DesktopIntegrationViewState;
  subscribe(listener: (state: DesktopIntegrationViewState) => void): () => void;
  refresh(): Promise<void>;
  setupClaudeCode(confirm: () => Promise<boolean>): Promise<void>;
  connectClaudeDesktop(confirm: () => Promise<boolean>): Promise<void>;
  openTerminal(): Promise<void>;
  dispose(): void;
}

export interface DesktopIntegrationsModalDependencies {
  controller: DesktopIntegrationsController;
  mobile: boolean;
  openConnectionSettings(): void;
  openBridgeSettings(): void;
  /** Opens Obsidian's own General settings, where the CLI switch lives. */
  openObsidianCliSettings(): void;
  confirm(target: "claude-code" | "claude-desktop", message: string): Promise<boolean>;
  claudeDesktopConfigPath?: string;
  platform: DesktopPlatform;
  closed?(): void;
}

/** An installed-but-failing binary reads as "unreachable", never "not found". */
function probeLabel(probe: ProbeResult): string {
  if (probe.available) return probe.version ?? "available";
  return probe.state === "unreachable" ? "installed, not responding" : "not found";
}

const CLAUDE_CODE_DISCLOSURE = "Adds cavi-ai/plugins to Claude Code when missing, then installs or enables obsidian-agent@cavi-ai at user scope.";
const CLAUDE_DESKTOP_DISCLOSURE = "Enables Companion's read-only loopback bridge and merges obsidian-vault into Claude Desktop's local configuration. Obsidian must remain open.";

export class DesktopIntegrationsModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly deps: DesktopIntegrationsModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Desktop integrations");
    if (this.deps.mobile) {
      this.contentEl.empty();
      this.contentEl.addClass("cc-desktop-integrations-modal");
      this.contentEl.createEl("p", {
        text: "Claude Code terminals and the Claude Desktop MCP bridge are desktop-only. Companion chat and agent mode continue to work on mobile without MCP.",
      });
      return;
    }
    this.unsubscribe = this.deps.controller.subscribe((state) => this.render(state));
    this.render(this.deps.controller.snapshot());
    void this.deps.controller.refresh();
  }

  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deps.controller.dispose();
    this.contentEl.empty();
    this.deps.closed?.();
  }

  private render(state: DesktopIntegrationViewState): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-desktop-integrations-modal");

    const companion = root.createEl("section", { cls: "cc-desktop-integration-card" });
    companion.createEl("h3", { text: "Companion" });
    companion.createEl("p", { text: "In-app chat and agent mode do not require MCP." });
    companion.createDiv({
      cls: `cc-desktop-integration-state ${state.providerReady ? "is-ready" : "is-needed"}`,
      text: state.providerReady ? "Provider ready" : "Connect a provider to start chatting",
    });
    if (!state.providerReady) {
      this.action(companion, "Open connection settings", false, () => {
        this.close();
        this.deps.openConnectionSettings();
      });
    }

    const claudeCode = root.createEl("section", { cls: "cc-desktop-integration-card" });
    claudeCode.createEl("h3", { text: "Claude Code" });
    claudeCode.createEl("p", { text: "Uses the official Obsidian CLI by default. No MCP server is required." });
    claudeCode.createEl("p", { cls: "cc-desktop-integration-disclosure", text: CLAUDE_CODE_DISCLOSURE });
    const inspection = state.inspection;
    if (inspection) {
      claudeCode.createDiv({
        cls: "cc-desktop-integration-state",
        text: `Claude Code: ${probeLabel(inspection.claude)} · Obsidian CLI: ${probeLabel(inspection.obsidian)}`,
      });
      // "not found" for a CLI that is installed but unreachable sends the user
      // after the wrong fix, so the remediation is spelled out here.
      if (inspection.obsidian.state === "unreachable") {
        claudeCode.createEl("p", { cls: "cc-desktop-integration-disclosure", text: OBSIDIAN_CLI_UNREACHABLE });
      } else if (inspection.obsidian.state === "missing") {
        claudeCode.createEl("p", {
          cls: "cc-desktop-integration-disclosure",
          text: `The Obsidian CLI is not installed. ${obsidianCliInstallHint(this.deps.platform)}`,
        });
      }
      // Obsidian owns the switch and the elevated Register that places the
      // command, so the most Companion can do is land the user on them.
      if (!inspection.obsidian.available && !this.deps.mobile) {
        this.action(claudeCode, "Open Obsidian CLI settings", false, () => this.deps.openObsidianCliSettings());
      }
    }
    const codeBusy = state.status === "loading" && state.operation === "claude-code";
    if (!inspection?.pluginInstalled || !inspection.pluginEnabled) {
      this.action(claudeCode, "Set up Claude Code", codeBusy, () => {
        void this.deps.controller.setupClaudeCode(() => this.deps.confirm("claude-code", CLAUDE_CODE_DISCLOSURE));
      });
    }
    if (inspection?.pluginInstalled && inspection.pluginEnabled && inspection.obsidian.available) {
      this.action(claudeCode, "Open terminal at vault", state.status === "loading" && state.operation === "terminal", () => {
        void this.deps.controller.openTerminal();
      });
    }

    const desktop = root.createEl("section", { cls: "cc-desktop-integration-card" });
    desktop.createEl("h3", { text: "Claude Desktop" });
    desktop.createEl("p", { text: "Claude Desktop is the integration that needs Companion's MCP bridge." });
    const desktopDisclosure = this.deps.claudeDesktopConfigPath
      ? `${CLAUDE_DESKTOP_DISCLOSURE} Configuration: ${this.deps.claudeDesktopConfigPath}`
      : CLAUDE_DESKTOP_DISCLOSURE;
    desktop.createEl("p", { cls: "cc-desktop-integration-disclosure", text: desktopDisclosure });
    this.action(desktop, "Connect Claude Desktop", state.status === "loading" && state.operation === "claude-desktop", () => {
      void this.deps.controller.connectClaudeDesktop(() => this.deps.confirm("claude-desktop", desktopDisclosure));
    });

    if (state.message) {
      root.createDiv({
        cls: "cc-desktop-integration-status",
        text: state.message,
        attr: { role: "status", "aria-live": "polite" },
      });
    }
    if (state.error) {
      const error = root.createDiv({ cls: "cc-desktop-integration-error", attr: { role: "alert" } });
      error.createEl("p", { text: state.error.message });
      if (state.error.recovery === "open-bridge-settings") {
        this.action(error, "Open bridge settings", false, () => {
          this.close();
          this.deps.openBridgeSettings();
        });
      } else if (state.error.recovery === "retry-refresh") {
        this.action(error, "Check again", false, () => { void this.deps.controller.refresh(); });
      } else if (state.error.recovery === "retry-claude-code") {
        this.action(error, "Retry Claude Code", false, () => {
          void this.deps.controller.setupClaudeCode(() => this.deps.confirm("claude-code", CLAUDE_CODE_DISCLOSURE));
        });
      } else {
        this.action(error, "Retry Claude Desktop", false, () => {
          void this.deps.controller.connectClaudeDesktop(() => this.deps.confirm("claude-desktop", desktopDisclosure));
        });
      }
    }
  }

  private action(parent: HTMLElement, label: string, disabled: boolean, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { text: label, attr: { type: "button" } });
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }
}

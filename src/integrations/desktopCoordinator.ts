import { CLI_HOST_LABELS, type CliHost, type CliHostInspection } from "./cliHosts";
import { sanitizeDesktopError, type ClaudeCodeInspection } from "./desktop";
import type {
  BridgeConnectionInput,
  ClaudeDesktopInstallInput,
  ClaudeDesktopInstallResult,
  TerminalLaunchResult,
} from "./desktopRuntime";

export interface DesktopIntegrationRuntime {
  inspectClaudeCode(): Promise<ClaudeCodeInspection>;
  setupClaudeCode(): Promise<ClaudeCodeInspection>;
  installClaudeDesktop(input: ClaudeDesktopInstallInput): Promise<ClaudeDesktopInstallResult>;
  refreshConnection?(input: BridgeConnectionInput): Promise<boolean>;
  inspectCliHosts?(): Promise<CliHostInspection[]>;
  connectCliHost?(host: CliHost, input: BridgeConnectionInput): Promise<CliHostInspection>;
  openTerminalAtVault(path: string): Promise<TerminalLaunchResult>;
  resolveClaudeCodeExecutable?(): Promise<string>;
}

export type DesktopIntegrationStatus = "idle" | "loading" | "ready" | "error";
export type DesktopRecovery = "retry-refresh" | "retry-claude-code" | "retry-claude-desktop" | "retry-codex" | "retry-agy" | "open-bridge-settings";

export interface DesktopIntegrationViewState {
  status: DesktopIntegrationStatus;
  providerReady: boolean;
  operation?: "refresh" | "claude-code" | "claude-desktop" | "terminal" | CliHost;
  inspection?: ClaudeCodeInspection;
  /** The agent CLIs Companion can connect, as last checked. */
  hosts?: CliHostInspection[];
  message?: string;
  error?: { message: string; recovery: DesktopRecovery };
  claudeDesktopConfigPath?: string;
}

export interface DesktopIntegrationCoordinatorOptions {
  runtime: DesktopIntegrationRuntime;
  providerReady(): boolean;
  vaultPath: string;
  /** The vault's name; the Claude Desktop extension opens the vault by it when Obsidian is closed. */
  vaultName?: string;
  prepareClaudeDesktopBridge(): Promise<{ port: number; token: string }>;
  copy(text: string): Promise<void>;
}

type Listener = (state: DesktopIntegrationViewState) => void;

export class DesktopIntegrationCoordinator {
  private state: DesktopIntegrationViewState;
  private readonly listeners = new Set<Listener>();
  private generation = 0;
  private disposed = false;
  private refreshInFlight: Promise<void> | null = null;
  private mutationInFlight: Promise<void> | null = null;

  constructor(private readonly options: DesktopIntegrationCoordinatorOptions) {
    this.state = { status: "idle", providerReady: options.providerReady() };
  }

  snapshot(): DesktopIntegrationViewState {
    return {
      ...this.state,
      ...(this.state.inspection ? { inspection: structuredClone(this.state.inspection) } : {}),
      ...(this.state.hosts ? { hosts: structuredClone(this.state.hosts) } : {}),
      ...(this.state.error ? { error: { ...this.state.error } } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.generation;
    this.setState({ status: "loading", operation: "refresh", providerReady: this.options.providerReady(), message: "Checking desktop integrations…" });
    const task = (async () => {
      try {
        const [inspection, hosts] = await Promise.all([
          this.options.runtime.inspectClaudeCode(),
          this.options.runtime.inspectCliHosts?.(),
        ]);
        if (!this.isCurrent(generation)) return;
        this.setState({
          status: "ready",
          providerReady: this.options.providerReady(),
          inspection,
          ...(hosts ? { hosts } : {}),
          message: inspection.pluginInstalled && inspection.pluginEnabled
            ? "Claude Code and obsidian-agent are ready."
            : "Companion is ready independently; optional desktop integrations can be set up below.",
        });
      } catch (cause) {
        if (!this.isCurrent(generation)) return;
        this.setError(cause, "retry-refresh");
      }
    })();
    const tracked = task.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = null;
    });
    this.refreshInFlight = tracked;
    return tracked;
  }

  setupClaudeCode(confirm: () => Promise<boolean>): Promise<void> {
    return this.runMutation("claude-code", "Setting up Claude Code…", "retry-claude-code", async (generation) => {
      if (!(await confirm()) || !this.isCurrent(generation)) return;
      const inspection = await this.options.runtime.setupClaudeCode();
      if (!this.isCurrent(generation)) return;
      this.setState({
        status: "ready",
        providerReady: this.options.providerReady(),
        inspection,
        message: "Claude Code and obsidian-agent are ready.",
      });
    });
  }

  connectClaudeDesktop(confirm: () => Promise<boolean>): Promise<void> {
    return this.runMutation("claude-desktop", "Connecting Claude Desktop…", "retry-claude-desktop", async (generation) => {
      if (!(await confirm()) || !this.isCurrent(generation)) return;
      let bridge: { port: number; token: string };
      try {
        bridge = await this.options.prepareClaudeDesktopBridge();
      } catch (cause) {
        if (this.isCurrent(generation)) this.setError(cause, "open-bridge-settings");
        return;
      }
      try {
        const vault = { name: this.options.vaultName ?? "", path: this.options.vaultPath };
        const result = await this.options.runtime.installClaudeDesktop({ ...bridge, vault });
        if (!this.isCurrent(generation)) return;
        this.setState({
          status: "ready",
          providerReady: this.options.providerReady(),
          message: "Claude Desktop is showing the Obsidian vault extension. Click Install; it connects to this vault on its own."
            + (result.legacyRemoved ? " The older Claude Desktop config entry was removed and backed up." : ""),
          claudeDesktopConfigPath: result.configPath,
        });
      } catch (cause) {
        throw new Error(
          sanitizeDesktopError(cause instanceof Error ? cause.message : String(cause), [bridge.token]),
          { cause },
        );
      }
    });
  }

  connectCliHost(host: CliHost, confirm: () => Promise<boolean>): Promise<void> {
    const label = CLI_HOST_LABELS[host];
    return this.runMutation(host, `Connecting ${label}…`, host === "codex" ? "retry-codex" : "retry-agy", async (generation) => {
      if (!(await confirm()) || !this.isCurrent(generation)) return;
      const runtime = this.options.runtime;
      if (!runtime.connectCliHost) throw new Error(`${label} cannot be connected on this device.`);
      let bridge: { port: number; token: string };
      try {
        bridge = await this.options.prepareClaudeDesktopBridge();
      } catch (cause) {
        if (this.isCurrent(generation)) this.setError(cause, "open-bridge-settings");
        return;
      }
      try {
        const vault = { name: this.options.vaultName ?? "", path: this.options.vaultPath };
        const result = await runtime.connectCliHost(host, { ...bridge, vault });
        if (!this.isCurrent(generation)) return;
        this.setState({
          status: "ready",
          providerReady: this.options.providerReady(),
          hosts: (this.state.hosts ?? []).filter((entry) => entry.host !== host).concat(result),
          message: `${label} has the vault tools as obsidian-vault. Start a new ${label} session to use them.`,
        });
      } catch (cause) {
        throw new Error(sanitizeDesktopError(cause instanceof Error ? cause.message : String(cause), [bridge.token]), { cause });
      }
    });
  }

  openTerminal(): Promise<void> {
    return this.runMutation("terminal", "Opening a terminal at this vault…", "retry-claude-code", async (generation) => {
      const result = await this.options.runtime.openTerminalAtVault(this.options.vaultPath);
      if (!this.isCurrent(generation)) return;
      if (result.opened) {
        this.setState({ status: "ready", providerReady: this.options.providerReady(), message: "Terminal opened at this vault. Run claude to begin." });
        return;
      }
      if (!result.instruction) throw new Error("No supported terminal launcher was found.");
      await this.options.copy(result.instruction);
      if (!this.isCurrent(generation)) return;
      this.setState({ status: "ready", providerReady: this.options.providerReady(), message: "No supported terminal launcher was found, so the safe launch command was copied." });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private runMutation(
    operation: NonNullable<DesktopIntegrationViewState["operation"]>,
    message: string,
    recovery: DesktopRecovery,
    action: (generation: number) => Promise<void>,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.mutationInFlight) return this.mutationInFlight;
    const generation = this.generation;
    this.setState({ status: "loading", operation, providerReady: this.options.providerReady(), message });
    const task = (async () => {
      try {
        await action(generation);
        if (this.isCurrent(generation) && this.state.status === "loading") {
          this.setState({ status: "idle", providerReady: this.options.providerReady() });
        }
      } catch (cause) {
        if (this.isCurrent(generation)) this.setError(cause, recovery);
      }
    })();
    const tracked = task.finally(() => {
      if (this.mutationInFlight === tracked) this.mutationInFlight = null;
    });
    this.mutationInFlight = tracked;
    return tracked;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private setError(cause: unknown, recovery: DesktopRecovery): void {
    const message = sanitizeDesktopError(cause instanceof Error ? cause.message : String(cause));
    this.setState({
      status: "error",
      providerReady: this.options.providerReady(),
      error: { message: message || "The desktop integration could not be completed.", recovery },
    });
  }

  private setState(state: DesktopIntegrationViewState): void {
    if (this.disposed) return;
    // The CLI list stays on screen through other actions until a check or a connect replaces it.
    this.state = state.hosts || !this.state.hosts ? state : { ...state, hosts: this.state.hosts };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

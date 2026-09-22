import type { PluginSettings } from "../types";
import type { VaultToolsOptions } from "./vaultTools";
import { resolveMcpToken, generateToken } from "./clientConfig";

interface ServerLike {
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): { port: number } | null;
  stats(): { activeRequests: number; handledRequests: number };
}

interface ToolRegistryLike {
  setOptions(opts: VaultToolsOptions): void;
}

export interface McpBridgeControllerDeps {
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  isMobile: boolean;

  isLifecycleEnded: () => boolean;
  lifecycleGeneration: () => number;

  buildToolOptions: () => VaultToolsOptions;
  createTools: (opts: VaultToolsOptions) => ToolRegistryLike;
  createServer: (tools: ToolRegistryLike, port: number, token: string) => Promise<ServerLike>;

  notice: (msg: string) => void;
}

export class McpBridgeController {
  private server: ServerLike | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private signature: string | null = null;
  private tools: ToolRegistryLike | null = null;

  constructor(private readonly deps: McpBridgeControllerDeps) {}

  sync(): Promise<void> {
    this.syncChain = this.syncChain.catch(() => {}).then(() => this.apply());
    return this.syncChain;
  }

  destroy(): void {
    void this.server?.stop();
    this.server = null;
    this.signature = null;
  }

  running(): boolean {
    return this.server?.isRunning() ?? false;
  }

  stats(): { running: boolean; port: number | null; activeRequests: number; handledRequests: number } {
    const s = this.server?.stats() ?? { activeRequests: 0, handledRequests: 0 };
    return {
      running: this.running(),
      port: this.server?.address()?.port ?? null,
      activeRequests: s.activeRequests,
      handledRequests: s.handledRequests,
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.deps.settings().mcpEnabled = enabled;
    if (enabled && !this.resolvedToken()) {
      this.deps.settings().mcpToken = generateToken();
    }
    await this.deps.saveSettings();
  }

  resolvedToken(): string {
    const env = (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    return resolveMcpToken(env, this.deps.settings().mcpToken).token;
  }

  private desiredSignature(): string | null {
    const s = this.deps.settings();
    if (this.deps.isMobile || !s.mcpEnabled) return null;
    return JSON.stringify({ port: s.mcpPort, token: this.resolvedToken(), writes: s.mcpAllowWrites, folder: s.mcpWriteFolder });
  }

  private async apply(): Promise<void> {
    const gen = this.deps.lifecycleGeneration();
    const desired = this.desiredSignature();
    if (desired !== null && this.server?.isRunning() && desired === this.signature) return;

    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.signature = null;
    }
    if (desired === null) return;

    const s = this.deps.settings();
    const toolOpts = this.deps.buildToolOptions();
    if (!this.tools) {
      this.tools = this.deps.createTools(toolOpts);
    } else {
      this.tools.setOptions(toolOpts);
    }

    try {
      const server = await this.deps.createServer(this.tools, s.mcpPort, this.resolvedToken());
      await server.start();
      if (
        this.deps.isLifecycleEnded()
        || this.deps.lifecycleGeneration() !== gen
        || this.desiredSignature() !== desired
      ) {
        await server.stop();
        return;
      }
      this.server = server;
      this.signature = desired;
    } catch (e) {
      this.deps.notice(`MCP bridge failed to start on port ${s.mcpPort}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

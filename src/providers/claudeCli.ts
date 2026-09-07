// Provider shell for the Claude Code CLI: credentials and the settings Test button. Streaming lives in cli/session.ts.

import type { CompletionRequest, Provider, ProviderStatus } from "./types";
import type { StreamHandlers } from "../types";
import type { ClaudeCliRuntime } from "../cli/runtime";

export interface CliProbe {
  executable: string;
  version: string;
  loggedIn: boolean;
  method: string;
}

export const CLI_NOT_FOUND = "Claude Code not found. Install it, then run `claude auth login`.";
export const CLI_NOT_SIGNED_IN = "Claude Code is not signed in. Run `claude auth login` in a terminal.";
export const CLI_DESKTOP_ONLY = "Claude Code runs on desktop only.";

export class ClaudeCliProvider implements Provider {
  readonly id = "claude-cli" as const;
  readonly label = "Claude Code";
  readonly supportsTools = true;
  private cached: CliProbe | null = null;

  constructor(private readonly runtime: ClaudeCliRuntime | null) {}

  available(): boolean {
    return this.runtime !== null;
  }

  hasCredentials(): boolean {
    return this.cached?.loggedIn === true;
  }

  executable(): string | null {
    return this.cached?.loggedIn ? this.cached.executable : null;
  }

  probe(): CliProbe | null {
    return this.cached;
  }

  async refresh(): Promise<ProviderStatus> {
    if (!this.runtime) return { ok: false, detail: CLI_DESKTOP_ONLY };
    const found = await this.runtime.findClaude();
    if (!found) {
      this.cached = null;
      return { ok: false, detail: CLI_NOT_FOUND };
    }
    const auth = await this.runtime.authStatus(found.executable);
    this.cached = { ...found, ...auth };
    if (!auth.loggedIn) return { ok: false, detail: CLI_NOT_SIGNED_IN };
    return { ok: true, detail: `Claude Code ${found.version} · signed in via ${auth.method || "unknown"} · ${found.executable}` };
  }

  test(): Promise<ProviderStatus> {
    return this.refresh();
  }

  stream(_req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    handlers.onError?.(new Error("The Claude Code backend streams through its turn runner, not the provider."));
    return Promise.resolve();
  }

  complete(): Promise<string> {
    return Promise.reject(new Error("The Claude Code backend streams through its turn runner, not the provider."));
  }
}

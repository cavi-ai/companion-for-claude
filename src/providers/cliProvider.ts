// Provider shell for a CLI chat backend (Claude Code, Codex, OpenCode): credentials and the settings Test button. Streaming lives in cli/session.ts.

import type { CompletionRequest, Provider, ProviderStatus } from "./types";
import type { StreamHandlers } from "../types";
import type { CliRuntime } from "../cli/runtime";
import type { CliBackend } from "../cli/backends/types";

export interface CliProbe {
  executable: string;
  version: string;
  loggedIn: boolean;
  method: string;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export class CliProvider implements Provider {
  readonly id: "claude-cli" | "codex-cli" | "opencode-cli";
  readonly label: string;
  readonly supportsTools = true;
  private cached: CliProbe | null = null;

  constructor(private readonly backend: CliBackend, private readonly runtime: CliRuntime | null) {
    this.id = backend.id;
    this.label = backend.label;
  }

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

  private notFoundMessage(): string {
    return `${this.label} not found. Install it, then ${this.backend.signInHint}.`;
  }

  private notSignedInMessage(): string {
    return `${this.label} is not signed in. ${capitalize(this.backend.signInHint)} in a terminal.`;
  }

  private desktopOnlyMessage(): string {
    return `${this.label} runs on desktop only.`;
  }

  async refresh(): Promise<ProviderStatus> {
    if (!this.runtime) return { ok: false, detail: this.desktopOnlyMessage() };
    const found = await this.runtime.find(this.backend);
    if (!found) {
      this.cached = null;
      return { ok: false, detail: this.notFoundMessage() };
    }
    const auth = await this.runtime.probe(this.backend, found.executable);
    this.cached = { ...found, ...auth };
    if (!auth.loggedIn) return { ok: false, detail: this.notSignedInMessage() };
    return { ok: true, detail: `${this.label} ${found.version} · signed in via ${auth.method || "unknown"} · ${found.executable}` };
  }

  test(): Promise<ProviderStatus> {
    return this.refresh();
  }

  stream(_req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    handlers.onError?.(new Error(`The ${this.label} backend streams through its turn runner, not the provider.`));
    return Promise.resolve();
  }

  complete(): Promise<string> {
    return Promise.reject(new Error(`The ${this.label} backend streams through its turn runner, not the provider.`));
  }
}

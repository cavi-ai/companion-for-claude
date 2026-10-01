// Provider shell for a CLI chat backend (Claude Code, Codex, OpenCode): credentials and the settings Test button. Streaming lives in cli/session.ts.

import type { CompletionRequest, Provider, ProviderStatus } from "./types";
import type { StreamHandlers } from "../types";
import type { CliRuntime } from "../cli/runtime";
import type { CliBackend } from "../cli/backends/types";
import type { CliChild } from "../cli/session";
import { runCliCompletion } from "../cli/completion";

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

  private readonly active = new Set<CliChild>();

  constructor(private readonly backend: CliBackend, private readonly runtime: CliRuntime | null, private readonly cwd?: () => string | null) {
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

  cancelAll(): void {
    for (const child of [...this.active]) child.kill("SIGTERM");
    this.active.clear();
  }

  private async run(req: CompletionRequest, onText?: (delta: string) => void): Promise<string> {
    const runtime = this.runtime;
    if (!runtime) throw new Error(this.desktopOnlyMessage());
    if (this.executable() === null) await this.refresh();
    const exe = this.executable();
    if (exe === null) throw new Error(this.cached === null ? this.notFoundMessage() : this.notSignedInMessage());
    const cwd = this.cwd?.() ?? null;
    if (cwd === null) throw new Error(this.desktopOnlyMessage());
    return runCliCompletion({
      backend: this.backend,
      spawn: (argv, env) => {
        const child = runtime.spawn(exe, argv, cwd, env);
        this.active.add(child);
        child.on("exit", () => this.active.delete(child));
        return child;
      },
      writeSystemPromptFile: (t) => runtime.writeSystemPromptFile(t),
      removeFile: (p) => runtime.removeFile(p),
    }, req, cwd, onText);
  }

  async stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    try {
      const full = await this.run(req, handlers.onText);
      handlers.onDone?.(full);
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  complete(req: CompletionRequest): Promise<string> {
    return this.run(req);
  }
}

// Shared shape every CLI chat backend implements: argv, env, auth probe, and JSONL event parsing.

import type { CompletionRequest } from "../../providers/types";
import type { CliEvent } from "../streamJson";

export interface CliAuthStatus {
  loggedIn: boolean;
  method: string;
}

/** Duck-typed CLI sign-in surface — real routers always have all three; a partial test stub is skipped, not crashed on. */
export interface CliSignInProvider {
  hasCredentials(): boolean;
  available(): boolean;
  refresh(): Promise<unknown>;
}

export interface CliArgvInput {
  model: string;
  systemPromptFile: string;
  mcpConfigJson: string;
  /** Exact bridge tool names; auto-approved on backends with a permission-prompt tool. */
  allowedTools: string[];
  maxTurns: number;
  sessionId?: string;
  resumeSessionId?: string;
  cwd: string;
  /** Per-turn backends only: this turn's prompt text (the CLI's positional argument). */
  message?: string;
  /** Per-turn backends only: prepended to `message` on the first turn only — these CLIs have no system-prompt-file flag. */
  systemPromptText?: string;
}

/**
 * `parseLine` returns an array, not the single `CliEvent | null` in the brief: Claude's
 * stream-json assistant message can carry several tool_use blocks in one line, and
 * truncating to one silently drops tool calls. Every backend returns 0-N events per line.
 */
export interface CliBackend {
  readonly id: "claude-cli" | "codex-cli" | "opencode-cli";
  readonly label: string;
  readonly binary: string;
  /** "persistent": one process per conversation, fed over stdin (claude). "per-turn": one process per run(), prompt as an argv (codex, opencode). */
  readonly processModel: "persistent" | "per-turn";
  /** False when the backend has no `--permission-prompt-tool` equivalent; writes gate in bridgeTools instead. */
  readonly supportsPermissionPrompt: boolean;
  /** Vault tools reach this backend over MCP; false ships chat-only with a setup-card note. */
  readonly supportsMcp: boolean;
  /** Instruction fragment for setup copy, e.g. "run `claude auth login`". */
  readonly signInHint: string;
  probe(run: (argv: string[]) => Promise<{ stdout: string; code: number }>): Promise<CliAuthStatus>;
  buildArgv(input: CliArgvInput): string[];
  env?(input: CliArgvInput): Record<string, string>;
  parseLine(line: string): CliEvent[];
  /** The stream-json line (or backend-native message) for the request's last user message. Backends without stdin messaging return null; the caller appends the message to argv/env instead. */
  userMessageLine?(req: CompletionRequest, transcript: string | null): string | null;
}

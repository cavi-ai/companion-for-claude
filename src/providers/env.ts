// Reads Anthropic-related variables from the process environment. Obsidian is a
// desktop-only Electron app, so `process.env` exists at runtime — but GUI-launched
// apps on macOS often don't inherit a shell's exported vars. We read what's there
// and let the caller fall back to the other auth modes when nothing is found.

export interface AnthropicEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
}

/** Snapshot the relevant env vars, guarding against a missing `process`. */
export function readAnthropicEnv(): AnthropicEnv {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (!env) return {};
    return {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    };
  } catch {
    return {};
  }
}

/** True if any usable Anthropic credential is present in the environment. */
export function hasAnthropicEnvCredential(env: AnthropicEnv = readAnthropicEnv()): boolean {
  return !!(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

// Whether a chat send would certainly fail without user configuration.
// Pure + testable; the ChatView setup card and send gate both key off this.

export interface SetupInputs {
  backend: "claude" | "local" | "auto" | "custom" | "claude-cli";
  hasAnthropicCredential: boolean;
  /** Claude Code binary found and signed in (desktop). */
  hasClaudeCli?: boolean;
}

/**
 * True when the user must add a credential before chatting. "local" never
 * gates (the host has a default and reachability is a runtime concern, not a
 * setup one); "claude" and "auto" both start their first attempt on Anthropic.
 */
export function needsCredentialSetup(s: SetupInputs): boolean {
  // Local backends never need an Anthropic credential.
  if (s.backend === "local" || s.backend === "custom") return false;
  if (s.backend === "claude-cli") return s.hasClaudeCli !== true;
  return !s.hasAnthropicCredential;
}

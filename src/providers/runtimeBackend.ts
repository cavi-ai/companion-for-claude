import type { PluginSettings } from "../types";

/** Runtime view of a synced preference; never rewrites desktop settings. */
export function chatBackendForRuntime(backend: PluginSettings["chatBackend"], isMobile: boolean): PluginSettings["chatBackend"] {
  return isMobile && backend.endsWith("-cli") ? "claude" : backend;
}

export function chatBackendOptions(isMobile: boolean): Record<string, string> {
  return {
    claude: "Claude only",
    device: "On-device GPU · inside Obsidian",
    ...(!isMobile ? {
      "claude-cli": "Claude Code — your subscription (desktop)",
      "codex-cli": "Codex — your subscription (desktop)",
      "opencode-cli": "OpenCode — your subscription (desktop)",
    } : {}),
    auto: "Auto (Claude, fall back to local)",
    local: isMobile ? "Ollama endpoint" : "Local only — Ollama (offline)",
    custom: "OpenAI-compatible endpoint",
  };
}

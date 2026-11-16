// Wires the Claude model list: fetched from the Models API only on the direct API backends with a credential.

import type ClaudeCompanionPlugin from "../main";
import { ClaudeModelRegistry } from "../claude/modelRegistry";

export type ModelsHost = Pick<ClaudeCompanionPlugin, "router" | "settings">;

export function buildClaudeModels(host: ModelsHost): ClaudeModelRegistry {
  const backendUsesApi = (): boolean => host.settings.chatBackend === "auto" || host.settings.chatBackend === "claude";
  return new ClaudeModelRegistry({
    identity: () => (backendUsesApi() ? host.router().anthropic.modelsIdentity() : null),
    fetch: () => host.router().anthropic.listModels(),
  });
}

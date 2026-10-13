// Pure settings mutations and decisions behind the settings tab's handlers.
// No Obsidian, no IO: callers save and re-render.

import type { McpServerConfig, PluginSettings } from "../types";

/** Settings holding a secret typed into a password field; stored trimmed. */
export type CredentialKey =
  | "apiKey" | "oauthToken" | "braveSearchApiKey" | "zoteroApiKey" | "cloudRoutineToken"
  | "cloudReplyToken" | "publishGithubToken" | "mcpToken";

export function setCredential(s: PluginSettings, key: CredentialKey, value: string): void {
  s[key] = value.trim();
}

export function addMcpServer(s: PluginSettings): void {
  s.mcpClientServers.push({ name: "", enabled: true, transport: "http", url: "", command: "", args: "" });
}

export function removeMcpServer(s: PluginSettings, index: number): void {
  s.mcpClientServers.splice(index, 1);
}

export type McpServerEdit =
  | { field: "enabled"; value: boolean }
  | { field: "name" | "args"; value: string }
  | { field: "transport"; value: McpServerConfig["transport"] }
  | { field: "url" | "command"; value: string };

/** Name and arguments are stored verbatim; URL and command are trimmed. */
export function editMcpServer(server: McpServerConfig, edit: McpServerEdit): void {
  switch (edit.field) {
    case "enabled":
      server.enabled = edit.value;
      return;
    case "transport":
      server.transport = edit.value;
      return;
    case "name":
    case "args":
      server[edit.field] = edit.value;
      return;
    case "url":
    case "command":
      server[edit.field] = edit.value.trim();
      return;
  }
}

/** Turning the bridge on mints a stored token only when neither the env var nor a stored token resolves. */
export function setMcpEnabled(s: PluginSettings, enabled: boolean, hasToken: () => boolean, mint: () => string): void {
  s.mcpEnabled = enabled;
  if (enabled && !hasToken()) s.mcpToken = mint();
}

export function regenerateMcpToken(s: PluginSettings, mint: () => string): void {
  s.mcpToken = mint();
}

export type EmbeddingSelection =
  | { key: "embeddingEngine"; value: PluginSettings["embeddingEngine"] }
  | { key: "builtinEmbeddingModel"; value: string };

/** Applies an embedding engine or built-in model choice; a rebuild is offered only when the index already held notes. */
export function selectEmbedding(
  s: PluginSettings,
  selection: EmbeddingSelection,
  indexedNotes: number,
): { changed: boolean; rebuildLabel: string | null } {
  if (selection.value === s[selection.key]) return { changed: false, rebuildLabel: null };
  if (selection.key === "embeddingEngine") s.embeddingEngine = selection.value;
  else s.builtinEmbeddingModel = selection.value;
  if (indexedNotes <= 0) return { changed: true, rebuildLabel: null };
  const rebuildLabel = selection.key === "embeddingEngine"
    ? (selection.value === "builtin" ? "the built-in model" : selection.value)
    : selection.value.replace(/^builtin:/, "");
  return { changed: true, rebuildLabel };
}

/** The cached-model hint shows only when the model is on disk, nothing is running, and no backend is loaded yet. */
export function showCachedModelHint(state: { cached: boolean; running: boolean; backendLoaded: boolean }): boolean {
  return state.cached && !state.running && !state.backendLoaded;
}

export function cachedModelHint(isMobile: boolean): string {
  return isMobile ? "Model cached — choose Load or Rebuild index to start this session." : "Model cached — loads on first use.";
}

/** A model cannot be deleted while a request or a download is using it. */
export function canDeleteDeviceModel(state: { chatBusy: boolean; downloading: boolean }): boolean {
  return !state.chatBusy && !state.downloading;
}

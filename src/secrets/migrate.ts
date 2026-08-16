// One-way move of plaintext credentials out of data.json and into the secret store.

import type { PluginSettings } from "../types";
import { SECRET_FIELDS, secretIdFor, type SecretField, type SecretStore } from "./store";

export interface MigrationResult {
  /** Fields whose plaintext value was moved into the store this run. */
  moved: SecretField[];
  /** Settings with the moved fields blanked, ready to persist. */
  settings: PluginSettings;
}

/** Fields currently holding a non-empty plaintext credential. */
export function pendingSecrets(settings: PluginSettings): SecretField[] {
  return SECRET_FIELDS.filter((field) => (settings[field] ?? "").trim() !== "");
}

/**
 * Move any plaintext credential into the store and blank it in the returned
 * settings. Idempotent: a second run finds nothing pending. No-op when the store
 * is unavailable, so pre-1.11.5 keeps today's behaviour rather than losing keys.
 * A field is blanked only when the write reads back — a backend that drops the
 * write leaves the credential where it already was.
 */
export function migrateSecrets(settings: PluginSettings, store: SecretStore): MigrationResult {
  if (!store.available()) return { moved: [], settings };
  const pending = pendingSecrets(settings);
  if (pending.length === 0) return { moved: [], settings };
  const out = { ...settings };
  const moved: SecretField[] = [];
  for (const field of pending) {
    if (!store.set(secretIdFor(field), (settings[field] ?? "").trim())) continue;
    out[field] = "";
    moved.push(field);
  }
  return { moved, settings: out };
}

const LABELS: Record<SecretField, string> = {
  apiKey: "Anthropic API key",
  oauthToken: "Anthropic OAuth token",
  openaiCompatKey: "custom endpoint key",
  zoteroApiKey: "Zotero API key",
  braveSearchApiKey: "Brave Search API key",
  mcpToken: "MCP bridge token",
  cloudRoutineToken: "cloud routine token",
  cloudReplyToken: "cloud reply GitHub token",
};

/**
 * Advisory shown once after a migration. Moving a credential does not un-leak
 * one that already rode vault sync or a commit, so it has to say rotate.
 */
export function migrationNotice(moved: SecretField[]): string {
  if (moved.length === 0) return "";
  const names = moved.map((field) => LABELS[field]).join(", ");
  return `Moved to your device's secret storage: ${names}. `
    + "These were previously stored in this vault's data.json. "
    + "If this vault has ever synced or been committed to git, rotate them — "
    + "moving a credential does not un-leak a copy that already left.";
}

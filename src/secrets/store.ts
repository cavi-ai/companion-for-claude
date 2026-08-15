// Credential storage. Secrets belong in Obsidian's OS-encrypted secret store,
// never in data.json — that file lives inside the vault and rides vault sync.

import { requireApiVersion } from "obsidian";
import type { App } from "obsidian";
import type { PluginSettings } from "../types";

/** 1.11.4 shipped the API storing plaintext in localStorage; 1.11.5 encrypts at rest. */
export const MIN_SECRET_API = "1.11.5";

export type SecretField =
  | "apiKey"
  | "oauthToken"
  | "openaiCompatKey"
  | "zoteroApiKey"
  | "braveSearchApiKey"
  | "mcpToken"
  | "cloudRoutineToken"
  | "cloudReplyToken";

/** Secret ids are lowercase alphanumeric with dashes; setSecret throws otherwise. */
const SECRET_IDS: Record<SecretField, string> = {
  apiKey: "claude-companion-api-key",
  oauthToken: "claude-companion-oauth-token",
  openaiCompatKey: "claude-companion-openai-compat-key",
  zoteroApiKey: "claude-companion-zotero-key",
  braveSearchApiKey: "claude-companion-brave-key",
  mcpToken: "claude-companion-mcp-token",
  cloudRoutineToken: "claude-companion-cloud-routine-token",
  cloudReplyToken: "claude-companion-cloud-reply-token",
};

export const SECRET_FIELDS = Object.keys(SECRET_IDS) as SecretField[];

export function secretIdFor(field: SecretField): string {
  return SECRET_IDS[field];
}

export interface SecretStore {
  available(): boolean;
  get(id: string): string | null;
  set(id: string, value: string): void;
}

interface SecretStorageApi {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** Adapter over app.secretStorage, gated on the version that encrypts at rest. */
export function createSecretStore(app: App): SecretStore {
  const api = (): SecretStorageApi | undefined =>
    (app as unknown as { secretStorage?: SecretStorageApi } | undefined)?.secretStorage;
  return {
    available: () => requireApiVersion(MIN_SECRET_API) && !!api(),
    get: (id) => api()?.getSecret(id) ?? null,
    set: (id, value) => { api()?.setSecret(id, value); },
  };
}

/** A store that is never available — the pre-1.11.5 path. */
export function unavailableStore(): SecretStore {
  return { available: () => false, get: () => null, set: () => {} };
}

/**
 * Copy with every credential blanked. Applied at the persist boundary so no
 * credential reaches data.json. The `out[field] = ""` assignment is also the
 * compile-time check that every SecretField is a string field on PluginSettings.
 */
export function stripSecrets(settings: PluginSettings): PluginSettings {
  const out = { ...settings };
  for (const field of SECRET_FIELDS) out[field] = "";
  return out;
}

/** Copy with credentials filled in from the store. In-memory settings stay whole. */
export function hydrate(settings: PluginSettings, store: SecretStore): PluginSettings {
  if (!store.available()) return { ...settings };
  const out = { ...settings };
  for (const field of SECRET_FIELDS) {
    const value = store.get(secretIdFor(field));
    if (value) out[field] = value;
  }
  return out;
}

/** Write one credential through to the store. No-op when unavailable. */
export function writeSecret(store: SecretStore, field: SecretField, value: string): void {
  if (!store.available()) return;
  store.set(secretIdFor(field), value);
}

/**
 * Push in-memory credentials to the store before a persist strips them.
 * Skips fields that are empty and absent, so unused credentials don't show up
 * as empty entries in Obsidian's Keychain pane.
 */
export function syncSecrets(settings: PluginSettings, store: SecretStore): void {
  if (!store.available()) return;
  for (const field of SECRET_FIELDS) {
    const id = secretIdFor(field);
    const value = settings[field] ?? "";
    const stored = store.get(id) ?? "";
    if (value === stored) continue;
    if (!value && !stored) continue;
    store.set(id, value);
  }
}

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
  /** True only when a read-back proves the value landed. */
  set(id: string, value: string): boolean;
}

interface SecretStorageApi {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/**
 * Adapter over app.secretStorage, gated on the version that encrypts at rest.
 * The backend can fail without the API saying so — Obsidian documents neither a
 * capability check nor what Linux does without kwallet/gnome-libsecret — so every
 * write is confirmed by reading it back, and every call is failure-tolerant.
 */
export function createSecretStore(app: App): SecretStore {
  const api = (): SecretStorageApi | undefined =>
    (app as unknown as { secretStorage?: SecretStorageApi } | undefined)?.secretStorage;
  const read = (id: string): string | null => {
    try {
      return api()?.getSecret(id) ?? null;
    } catch {
      return null;
    }
  };
  return {
    available: () => requireApiVersion(MIN_SECRET_API) && !!api(),
    get: read,
    set: (id, value) => {
      try {
        api()?.setSecret(id, value);
      } catch {
        return false;
      }
      return read(id) === value;
    },
  };
}

/** A store that is never available — the pre-1.11.5 path. */
export function unavailableStore(): SecretStore {
  return { available: () => false, get: () => null, set: () => false };
}

export interface StripResult {
  /** Copy safe to persist: credentials the store holds are blanked. */
  settings: PluginSettings;
  /** Credentials the store does not hold, so data.json still carries them. */
  unverified: SecretField[];
}

/**
 * Applied at the persist boundary: a credential leaves data.json only when the
 * store provably holds it. A field the store dropped stays in the file rather
 * than vanishing from both places. The `out[field] = ""` assignment is also the
 * compile-time check that every SecretField is a string field on PluginSettings.
 */
export function stripVerifiedSecrets(settings: PluginSettings, store: SecretStore): StripResult {
  const out = { ...settings };
  const unverified: SecretField[] = [];
  for (const field of SECRET_FIELDS) {
    const value = settings[field] ?? "";
    if (value === "" || store.get(secretIdFor(field)) === value) out[field] = "";
    else unverified.push(field);
  }
  return { settings: out, unverified };
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
export function writeSecret(store: SecretStore, field: SecretField, value: string): boolean {
  if (!store.available()) return false;
  return store.set(secretIdFor(field), value);
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

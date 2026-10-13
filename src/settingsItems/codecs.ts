import type { PluginSettings } from "../types";

export function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Text controls hand back a string; anything else is an empty field. */
function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function splitTags(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Settings whose stored shape differs from the control's value. */
export const CODECS: Record<string, { read(s: PluginSettings): unknown; write(s: PluginSettings, v: unknown): void }> = {};

/** `v.trim()` on the way in, verbatim on the way out. */
function trimmed(key: keyof PluginSettings): void {
  CODECS[key] = {
    read: (s) => s[key],
    write: (s, v) => { (s as unknown as Record<string, unknown>)[key] = asText(v).trim(); },
  };
}

/** `v.trim() || fallback` — an emptied folder/host field returns to its default. */
function trimmedOr(key: keyof PluginSettings, fallback: string): void {
  CODECS[key] = {
    read: (s) => s[key],
    write: (s, v) => { (s as unknown as Record<string, unknown>)[key] = asText(v).trim() || fallback; },
  };
}

/** Comma-separated in the field, string[] in settings. */
function tagList(key: "artifactBaseTags" | "chatBaseTags" | "sourceBaseTags"): void {
  CODECS[key] = {
    read: (s) => s[key].join(", "),
    write: (s, v) => { s[key] = splitTags(asText(v)); },
  };
}

for (const key of [
  "apiKey", "oauthToken", "baseUrl", "customModel", "ollamaUtilityModel", "classifierModel", "openaiCompatHost", "openaiCompatKey",
  "openAlexContactEmail", "zoteroUserId", "zoteroApiKey", "braveSearchApiKey", "cloudRoutineFireUrl",
  "cloudRoutineToken", "cloudReplyRepo", "cloudReplyToken", "mcpToken", "publishGithubToken", "publishApiBase",
] as const) trimmed(key);

for (const [key, fallback] of [
  ["artifactFolder", "Claude/Artifacts"], ["chatFolder", "Claude/Chats"], ["planFolder", "Claude/Plans"],
  ["templatesFolder", "Claude/Templates"], ["memoryFolder", "Claude/Sessions"], ["sourceInboxFolder", "Clippings"],
  ["clipOrganizedFolder", "Library"], ["ontologyFolder", "Ontology"], ["cloudReplyBranch", "main"],
  ["cloudReplyFolder", "Claude/Replies"], ["mcpWriteFolder", "Claude/Inbox"], ["ollamaHost", "http://localhost:11434"],
  ["ollamaModel", "llama3.1"], ["embeddingModel", "nomic-embed-text"],
] as const) trimmedOr(key, fallback);

for (const key of ["artifactBaseTags", "chatBaseTags", "sourceBaseTags"] as const) tagList(key);

for (const key of ["activeNote", "selection", "linkedNotes", "searchVault"] as const) {
  CODECS[`context.${key}`] = {
    read: (s) => s.context[key],
    write: (s, v) => { s.context[key] = v === true; },
  };
}

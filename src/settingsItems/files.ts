// Static pages: Behavior, Files & tags, Session memory, Vault ontology, the
// privacy note, and the mobile desktop-only note.

import { Platform, type SettingGroupItem } from "obsidian";

export function behaviorItems(): SettingGroupItem[] {
  return [
    {
      name: "System prompt",
      desc: "Prepended to every conversation. The artifact design system is always appended automatically.",
      control: { type: "textarea", key: "systemPrompt", rows: 5 },
    },
    {
      name: "Context character budget",
      desc: "Max characters of vault context attached to a request.",
      control: { type: "number", key: "contextCharBudget", min: 1, step: 1 },
    },
    {
      name: "Max context notes",
      desc: "How many linked / search-matched notes to include.",
      control: { type: "number", key: "maxContextNotes", min: 0, step: 1 },
    },
    {
      name: "New chat context: active note",
      desc: "Each new chat starts with the active note attached. @mentions and the context menu change only that chat.",
      control: { type: "toggle", key: "context.activeNote" },
    },
    {
      name: "New chat context: selection",
      desc: "Each new chat starts with your highlighted text attached.",
      control: { type: "toggle", key: "context.selection" },
    },
    {
      name: "New chat context: linked notes",
      desc: "Each new chat starts with notes linked to and from the active note.",
      control: { type: "toggle", key: "context.linkedNotes" },
    },
    {
      name: "New chat context: vault search",
      desc: "Each new chat starts with keyword or semantic vault search on (off in agent mode, where Claude searches with tools).",
      control: { type: "toggle", key: "context.searchVault" },
    },
  ];
}

export function storageItems(): SettingGroupItem[] {
  return [
    {
      name: "Open artifacts in",
      desc: "Where the “Open” button on an artifact sends it. Keeping it in Obsidian is tidiest; choose a browser to pop it out.",
      // Shelling out to a browser needs a desktop runtime.
      visible: () => !Platform.isMobile,
      control: {
        type: "dropdown",
        key: "artifactOpenTarget",
        options: {
          obsidian: "Obsidian (in-app, full screen)",
          default: "System default browser",
          chrome: "Google Chrome",
          safari: "Safari",
          brave: "Brave",
          firefox: "Firefox",
        },
      },
    },
    { name: "Artifacts folder", desc: "Where saved artifacts (interactive HTML notes) are written.", control: { type: "text", key: "artifactFolder", placeholder: "Claude/Artifacts" } },
    { name: "Chats folder", desc: "Where saved chat transcripts are written.", control: { type: "text", key: "chatFolder", placeholder: "Claude/Chats" } },
    { name: "Plans folder", desc: "Where saved plan notes (artifact + Build-task checklist) are written.", control: { type: "text", key: "planFolder", placeholder: "Claude/Plans" } },
    { name: "Templates folder", desc: "Markdown notes here become your own slash commands in chat (frontmatter: name, description, optional model/context).", control: { type: "text", key: "templatesFolder", placeholder: "Claude/Templates" } },
    { name: "Conversation history limit", desc: "How many past chats to keep (oldest are pruned). Use 0 for unlimited.", control: { type: "number", key: "maxConversations", min: 0, step: 1 } },
  ];
}

export function indexingItems(): SettingGroupItem[] {
  return [
    { name: "Auto-tag on save", desc: "When saving an artifact or chat, generate topic tags + a one-line summary (uses the utility provider) so notes are indexed correctly.", control: { type: "toggle", key: "autoTagOnSave" } },
    { name: "Artifact base tags", desc: "Comma-separated tags every saved artifact gets (for reliable filtering).", control: { type: "text", key: "artifactBaseTags" } },
    { name: "Chat base tags", desc: "Comma-separated tags every saved chat gets.", control: { type: "text", key: "chatBaseTags" } },
  ];
}

export function memoryItems(): SettingGroupItem[] {
  return [
    { name: "Enable session memory", desc: "Show the capture command, the “ingest” checkbox, and the memory sidebar.", control: { type: "toggle", key: "memoryEnabled" } },
    { name: "Memory folder", desc: "Where session digest notes are written.", control: { type: "text", key: "memoryFolder", placeholder: "Claude/Sessions" } },
    { name: "Ingest on save (default)", desc: "Default state of the “ingest” checkbox next to Save in the chat view.", control: { type: "toggle", key: "memoryIngestOnSave" } },
    { name: "Auto-consolidate memory", desc: "After each capture, merge recent digests into the “What Claude Knows” note (uses the utility model — local when enabled).", control: { type: "toggle", key: "memoryAutoConsolidate" } },
  ];
}

export function ontologyItems(): SettingGroupItem[] {
  return [
    { name: "Enable ontology", desc: "Claude writes typed frontmatter and wikilink relations that conform to schema notes in your vault. Run “Seed ontology” to create the default schemas.", control: { type: "toggle", key: "ontologyEnabled" } },
    { name: "Ontology folder", desc: "Where the schema notes live (one note per type). Edit those notes to change the schema.", control: { type: "text", key: "ontologyFolder", placeholder: "Ontology" } },
  ];
}

export function privacyItems(): SettingGroupItem[] {
  return [
    {
      name: "What this plugin accesses",
      aliases: ["privacy", "network", "telemetry"],
      desc:
        "Your messages and vault context go only to Anthropic (and your local Ollama or OpenAI-compatible endpoint, if enabled). "
        + "The built-in semantic-search engine downloads its model once from huggingface.co and cdn.jsdelivr.net when you click Download; afterwards it runs fully offline. "
        + "On desktop, optional features touch files outside the vault: session capture reads Claude Code transcripts from your Claude projects folder, and “open artifact in browser” writes a temporary HTML file. "
        + "Semantic search reads every note in your vault to build a local index. Copy buttons use the system clipboard. All filesystem access is disabled on mobile.",
    },
  ];
}

export function desktopOnlyItems(): SettingGroupItem[] {
  return [
    {
      name: "Available on a computer",
      desc: "These need a desktop runtime and are available when you open this vault on a computer: local models (Ollama & endpoints), the Claude Desktop / advanced MCP bridge, and session capture (browsing captured memory works on mobile).",
    },
  ];
}

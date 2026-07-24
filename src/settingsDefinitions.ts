import type { SettingDefinition, SettingDefinitionItem } from "obsidian";

interface Entry {
  name: string;
  desc: string;
  aliases?: string[];
}

function group(heading: string, entries: Entry[]): SettingDefinitionItem {
  const items: SettingDefinition[] = entries.map((e) =>
    e.aliases ? { name: e.name, desc: e.desc, aliases: e.aliases } : { name: e.name, desc: e.desc },
  );
  return { type: "group", heading, items };
}

/**
 * Declarative setting definitions (Obsidian 1.13+) so Companion's settings
 * appear in Obsidian's settings search. Search-metadata only — the tab still
 * renders imperatively via display(); these entries carry name/desc/aliases
 * and no controls, so they can never mutate values from search results.
 * Keep in sync with settings.ts.
 */
export function settingDefinitions(): SettingDefinitionItem[] {
  return [
    group("Connection", [
      { name: "Authentication", desc: "API key, Claude subscription OAuth token, or environment import.", aliases: ["api key", "login", "sign in", "claude"] },
      { name: "Anthropic API key", desc: "Bring your own key from console.anthropic.com.", aliases: ["api key", "sk-ant"] },
      { name: "OAuth token", desc: "Long-term token from `claude setup-token`; usage bills to your subscription.", aliases: ["subscription", "setup-token"] },
      { name: "API base URL", desc: "Optional gateway/proxy instead of api.anthropic.com.", aliases: ["proxy", "gateway", "endpoint"] },
      { name: "Save & test connection", desc: "Verify your credential with a tiny request.", aliases: ["test", "verify"] },
    ]),
    group("Chat", [
      { name: "Model", desc: "Which Claude model answers in chat.", aliases: ["claude", "opus", "sonnet", "haiku"] },
      { name: "Custom model id", desc: "Override the dropdown with a raw model id." },
      { name: "Chat backend", desc: "Claude, local model, or Auto with fallback.", aliases: ["ollama", "offline", "fallback"] },
      { name: "Max response tokens", desc: "Upper bound on each reply." },
      { name: "System prompt", desc: "Prepended to every conversation." },
      { name: "Chat font size", desc: "Composer and message text size.", aliases: ["text size"] },
    ]),
    group("Context", [
      { name: "Context character budget", desc: "How much vault context rides along with each message." },
      { name: "Max context notes", desc: "Cap on notes pulled into context." },
    ]),
    group("Agent (act on your vault)", [
      { name: "Let Claude use vault tools", desc: "Claude searches and reads notes on its own while answering.", aliases: ["agent", "tools"] },
      { name: "Allow write tools", desc: "Claude may create and edit notes, confirming every write first.", aliases: ["agent", "writes", "edit"] },
      { name: "Max tool iterations per turn", desc: "Search/read/write rounds before Claude must answer.", aliases: ["agent"] },
    ]),
    group("Agent in the cloud", [
      { name: "Enable cloud dispatch", desc: "Adds the “Send to cloud Claude session” command.", aliases: ["mobile", "routine", "claude code"] },
      { name: "Routine fire URL", desc: "The routine's fire endpoint from the Claude Code web UI.", aliases: ["routine", "endpoint"] },
      { name: "Routine token", desc: "Per-routine bearer token for cloud dispatch." },
      { name: "API beta header", desc: "anthropic-beta header gating the experimental Routines API." },
    ]),
    group("Cloud replies", [
      { name: "Vault repo", desc: "owner/name of the GitHub repo backing your vault.", aliases: ["github"] },
      { name: "Replies branch", desc: "Branch the cloud session writes replies to." },
      { name: "Replies folder", desc: "Repo folder where reply notes land." },
      { name: "GitHub token", desc: "Token used to pull reply notes over the Contents API.", aliases: ["github"] },
    ]),
    group("Semantic search", [
      { name: "Enable semantic search", desc: "Local vector index so the vault is searchable by meaning.", aliases: ["embeddings", "vector", "related"] },
      { name: "Embedding engine", desc: "Built-in on-device model or Ollama.", aliases: ["embeddings"] },
      { name: "Embedding model", desc: "Download, load, or clear the on-device embedding model.", aliases: ["download"] },
      { name: "Rebuild index", desc: "Re-embed the whole vault.", aliases: ["reindex"] },
    ]),
    group("Indexing & tags", [
      { name: "Auto-tag on save", desc: "Suggest tags for saved artifacts and chats.", aliases: ["tags"] },
      { name: "Artifact base tags", desc: "Tags every saved artifact gets." },
      { name: "Chat base tags", desc: "Tags every saved chat gets." },
    ]),
    group("Source capture", [
      { name: "Enable source capture", desc: "Watch the inbox and type new clips into source notes.", aliases: ["clipper", "web clipper"] },
      { name: "Auto-enrich on create", desc: "Type files automatically as they appear in the inbox.", aliases: ["enrich"] },
      { name: "Inbox folder", desc: "Folder the Web Clipper writes to and Companion watches." },
      { name: "Base tags", desc: "Tags added to every enriched source note." },
    ]),
    group("Vault ontology", [
      { name: "Enable ontology", desc: "Typed frontmatter and wikilink relations from schema notes.", aliases: ["schema", "types"] },
      { name: "Ontology folder", desc: "Where schema notes live.", aliases: ["schema"] },
    ]),
    group("Scholarly discovery", [
      { name: "Enable scholarly discovery", desc: "OpenAlex, Crossref, and arXiv search in the Research Workbench.", aliases: ["research", "papers", "openalex"] },
      { name: "OpenAlex contact email", desc: "Polite-pool contact for OpenAlex requests." },
      { name: "Discovery reranker", desc: "Which model reranks discovery results." },
      { name: "Clear discovery cache", desc: "Delete derived discovery state." },
    ]),
    group("Local models (Ollama)", [
      { name: "Use local model for utility tasks", desc: "Route summaries, tagging, and ingestion to Ollama.", aliases: ["ollama", "offline"] },
      { name: "Ollama host", desc: "Local Ollama server address.", aliases: ["ollama"] },
      { name: "Local model", desc: "Ollama model for chat and utility work.", aliases: ["ollama"] },
      { name: "Test local connection", desc: "Verify the Ollama server is reachable.", aliases: ["ollama"] },
    ]),
    group("Agent bridge — MCP server", [
      { name: "Enable MCP server", desc: "Expose the vault to Claude Code and Claude Desktop over loopback HTTP.", aliases: ["mcp", "claude code", "bridge"] },
      { name: "Port", desc: "Loopback port the bridge listens on.", aliases: ["mcp"] },
      { name: "Allow writes", desc: "Let bridge clients create and edit notes.", aliases: ["mcp", "writes"] },
      { name: "Write folder", desc: "Default folder for notes created over the bridge.", aliases: ["mcp"] },
      { name: "Show token in snippets", desc: "Reveal the bearer token in the connection snippets.", aliases: ["mcp", "token"] },
    ]),
    group("Session memory", [
      { name: "Enable session memory", desc: "Digest Claude Code sessions into vault notes.", aliases: ["claude code", "memory"] },
      { name: "Memory folder", desc: "Where session digest notes are written." },
      { name: "Ingest on save (default)", desc: "Default state of the chat-view ingest checkbox." },
      { name: "Auto-consolidate memory", desc: "Merge digests into the “What Claude Knows” note after each capture." },
    ]),
    group("Artifacts & notes", [
      { name: "Open artifacts in", desc: "Render artifacts in Obsidian or an external browser." },
      { name: "Inline artifact height", desc: "Pixel height of the sandboxed artifact frame." },
      { name: "Artifacts folder", desc: "Where saved artifacts are written." },
      { name: "Chats folder", desc: "Where saved chats are written." },
      { name: "Plans folder", desc: "Where plan notes are written." },
      { name: "Conversation history limit", desc: "How many saved chats are kept.", aliases: ["history", "retention"] },
    ]),
  ];
}

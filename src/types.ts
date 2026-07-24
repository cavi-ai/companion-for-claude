// Shared types for the Claude Companion plugin.

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  /** Raw markdown content of the message — what's sent to the model. */
  content: string;
  /**
   * Optional human-facing label shown in the chat instead of `content`. Used to
   * hide verbose internal instructions (e.g. the plan/artifact prompt templates)
   * behind a friendly line like "Generate implementation plan" — the model still
   * receives the full `content`.
   */
  display?: string;
  /**
   * Display-only record of the tool calls behind an assistant turn (agent mode).
   * Used to re-render tool chips on conversation replay; never sent to the model.
   */
  toolTrace?: ToolTraceEntry[];
}

/** One tool call as shown in the chat UI (not the wire format). */
export interface ToolTraceEntry {
  name: string;
  /** Compact one-line rendering of the arguments (e.g. the search query). */
  argsSummary: string;
  /** Truncated result text for the expandable chip. */
  resultPreview: string;
  ok: boolean;
}

export interface ContextToggles {
  activeNote: boolean;
  selection: boolean;
  linkedNotes: boolean;
  searchVault: boolean;
}

export interface ClaudeModel {
  id: string;
  label: string;
  hint?: string;
}

export type AuthMode = "apiKey" | "oauthToken" | "environment";

/** Where the "Open" button on an artifact sends it. "obsidian" = in-app fullscreen. */
export type ArtifactOpenTarget = "obsidian" | "default" | "chrome" | "safari" | "brave" | "firefox";

export interface PluginSettings {
  apiKey: string;
  /** How to authenticate to Anthropic: API key (default), long-term OAuth token, or the environment. */
  authMode: AuthMode;
  /** Long-term OAuth token from `claude setup-token` (sk-ant-oat…). Used when authMode is "oauthToken". */
  oauthToken: string;
  /** Override base URL for the Anthropic API (e.g. a gateway). Empty = api.anthropic.com. */
  baseUrl: string;
  model: string;
  customModel: string;
  maxTokens: number;
  systemPrompt: string;
  /** Where the artifact "Open" button sends a rendered artifact. */
  artifactOpenTarget: ArtifactOpenTarget;
  artifactFolder: string;
  chatFolder: string;
  /** Folder for generated plan notes (artifact + build-task checklist, type: plan). */
  planFolder: string;
  context: ContextToggles;
  /** Max characters of vault context to attach to a request. */
  contextCharBudget: number;
  /** How many linked / search-matched notes to include. */
  maxContextNotes: number;
  /** Default render height (px) for inline `claude-html` artifacts. */
  artifactHeight: number;
  /** Chat message font size (px). Independent of Obsidian's editor font. */
  chatFontSize: number;
  /** Max chat conversations to retain in history (oldest pruned). 0 = unlimited. */
  maxConversations: number;

  // ----- local models (Ollama) -----
  /** Base URL of the local Ollama server. */
  ollamaHost: string;
  /** Default local model for utility tasks (summaries, tagging). */
  ollamaModel: string;
  /** Route cheap "utility" work (summarize/tag/ingest) to Ollama. */
  localUtilityEnabled: boolean;
  /** Chat backend: always Claude, always local, or auto (Claude with local fallback). */
  chatBackend: "claude" | "local" | "auto";
  /** Provider policy for explicit Research Intelligence narrative analysis. */
  intelligenceNarrator: "current" | "claude" | "local" | "disabled";

  // ----- scholarly discovery -----
  /** Enable explicit, user-triggered scholarly discovery network requests. */
  discoveryEnabled: boolean;
  /** Optional contact address sent to OpenAlex. */
  openAlexContactEmail: string;
  /** Provider policy for explicit discovery reranking. */
  discoveryReranker: "current" | "claude" | "local" | "disabled";
  discoveryMaxResults: number;
  discoveryExpansionLimit: number;
  discoveryCacheHours: number;

  // ----- semantic search (local embeddings) -----
  /** Build a local vector index so the vault is searchable by meaning. */
  semanticEnabled: boolean;
  /** Ollama embedding model (e.g. nomic-embed-text). Local + private. */
  embeddingModel: string;
  /** Which engine computes embeddings: the bundled in-webview model or Ollama. */
  embeddingEngine: "builtin" | "ollama";
  /** Set once the built-in embedding-model download prompt has been shown. */
  semanticModelPrompted: boolean;

  // ----- indexing -----
  /** Auto-add tags + summary frontmatter when saving artifacts/chats. */
  autoTagOnSave: boolean;
  /** Tags every saved artifact gets, for reliable indexing. */
  artifactBaseTags: string[];
  /** Tags every saved chat gets. */
  chatBaseTags: string[];

  // ----- agent mode (vault tools in chat) -----
  /** Offer read-only vault tools to Claude in chat, so it can search/read on its own. */
  agentModeEnabled: boolean;
  /** Also offer write tools (create/append/update/move). Each write asks for confirmation. */
  agentAllowWrites: boolean;
  /** Max stream→tools→stream iterations per turn. */
  agentMaxIterations: number;

  // ----- MCP bridge (vault-as-MCP-server) -----
  /** Run a local MCP server exposing vault tools to Claude Code / Desktop. */
  mcpEnabled: boolean;
  /** Port for the local MCP server (loopback only). */
  mcpPort: number;
  /** Bearer token required by MCP clients. */
  mcpToken: string;
  /** Allow MCP clients to create/append notes (read is always allowed). */
  mcpAllowWrites: boolean;
  /** Default folder for notes created via MCP. */
  mcpWriteFolder: string;

  // ----- cloud dispatch (Claude Code Routines API) -----
  /** Enable the "Send to cloud Claude session" command (fires a pre-created routine). */
  cloudDispatchEnabled: boolean;
  /** The routine's full "fire" endpoint, copied from the Claude Code web UI. */
  cloudRoutineFireUrl: string;
  /** Per-routine bearer token (sk-ant-oat…), scoped to firing this one routine. */
  cloudRoutineToken: string;
  /** anthropic-beta header gating the experimental Routines API. */
  cloudRoutineBetaHeader: string;

  // ----- cloud replies (read cloud-session output from the vault repo) -----
  /** "owner/name" of the vault's GitHub repo to pull replies from. */
  cloudReplyRepo: string;
  /** Branch the cloud session writes replies to. */
  cloudReplyBranch: string;
  /** Folder in the repo where reply notes are written. */
  cloudReplyFolder: string;
  /** GitHub token with Contents:read, to fetch replies over HTTPS. */
  cloudReplyToken: string;

  // ----- episodic memory (capture Claude Code sessions into the vault) -----
  /** Master switch for the session-memory feature (commands + view). */
  memoryEnabled: boolean;
  /** Folder where session digest notes are written. */
  memoryFolder: string;
  /** Default state of the "ingest on save" checkbox in the chat view. */
  memoryIngestOnSave: boolean;
  /** Tags every session digest note gets. */
  memoryBaseTags: string[];
  /** After each capture, merge recent digests into the "What Claude Knows" note. */
  memoryAutoConsolidate: boolean;

  // ----- source capture (typed clip enrichment) -----
  /** Master switch: watch the inbox and enrich new clips/files into typed notes. */
  sourceCaptureEnabled: boolean;
  /** Auto-enrich files as they appear in the inbox folder (vs. manual command only). */
  sourceEnrichOnCreate: boolean;
  /** One-time consent for auto-enriching inbox files with the utility model ("ask" until the user chooses). */
  sourceCaptureConsent: "ask" | "allow" | "deny";
  /** Folder the Web Clipper writes to and Companion watches. */
  sourceInboxFolder: string;
  /** Tags every enriched source note gets. */
  sourceBaseTags: string[];
  /** Per-type schema overrides, keyed by source type. */
  sourceSchemaOverrides: Record<string, { version?: number; fields?: unknown[] }>;

  // ----- vault ontology (typed notes & relations) -----
  /** Master switch: seed/validate typed frontmatter and relations. */
  ontologyEnabled: boolean;
  /** Folder holding the schema notes (one note per type). */
  ontologyFolder: string;
  /** Set once the ontology seed prompt has been shown (don't nag again). */
  ontologySeedPrompted: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: "",
  authMode: "apiKey",
  oauthToken: "",
  baseUrl: "",
  model: "claude-sonnet-5",
  customModel: "",
  maxTokens: 20000,
  systemPrompt:
    "You are Claude, working inside the user's Obsidian vault. Be concise and precise. " +
    "Answer ordinary questions and short requests in normal Markdown. Only when the user asks for a " +
    "deliverable that benefits from visual structure (a plan, audit, report, dashboard, comparison, or diagram) " +
    "produce a single self-contained ```claude-html artifact using the provided design system and the template that fits the request.",
  artifactOpenTarget: "obsidian",
  artifactFolder: "Claude/Artifacts",
  chatFolder: "Claude/Chats",
  planFolder: "Claude/Plans",
  context: {
    activeNote: true,
    selection: true,
    linkedNotes: false,
    searchVault: false,
  },
  contextCharBudget: 24000,
  maxContextNotes: 6,
  artifactHeight: 640,
  chatFontSize: 14,
  maxConversations: 200,

  ollamaHost: "http://localhost:11434",
  ollamaModel: "llama3.1",
  localUtilityEnabled: false,
  chatBackend: "claude",
  intelligenceNarrator: "current",

  discoveryEnabled: true,
  openAlexContactEmail: "",
  discoveryReranker: "current",
  discoveryMaxResults: 20,
  discoveryExpansionLimit: 20,
  discoveryCacheHours: 24,

  semanticEnabled: true,
  embeddingModel: "nomic-embed-text",
  embeddingEngine: "builtin",
  /** Set once the built-in embedding-model download prompt has been shown. */
  semanticModelPrompted: false,

  autoTagOnSave: true,
  artifactBaseTags: ["claude", "artifact"],
  chatBaseTags: ["claude", "chat"],

  agentModeEnabled: true,
  // On by default so chat can actually act on the vault (create/edit notes,
  // canvases, bases) — not just narrate it. Every write still asks for
  // confirmation before it touches the vault, so this is safe; the in-chat
  // "Act on vault" toggle flips it per session.
  agentAllowWrites: true,
  agentMaxIterations: 10,

  mcpEnabled: false,
  mcpPort: 22360,
  mcpToken: "",
  mcpAllowWrites: false,
  mcpWriteFolder: "Claude/Inbox",

  cloudDispatchEnabled: false,
  cloudRoutineFireUrl: "",
  cloudRoutineToken: "",
  cloudRoutineBetaHeader: "experimental-cc-routine-2026-04-01",

  cloudReplyRepo: "",
  cloudReplyBranch: "main",
  cloudReplyFolder: "Claude/Replies",
  cloudReplyToken: "",

  memoryEnabled: true,
  memoryFolder: "Claude/Sessions",
  memoryIngestOnSave: false,
  memoryBaseTags: ["claude", "session"],
  memoryAutoConsolidate: false,

  sourceCaptureEnabled: true,
  sourceEnrichOnCreate: true,
  sourceCaptureConsent: "ask",
  sourceInboxFolder: "Clippings",
  sourceBaseTags: ["source"],
  sourceSchemaOverrides: {},

  ontologyEnabled: true,
  ontologyFolder: "Ontology",
  ontologySeedPrompted: false,
};

export type DiscoveryNumericSettings = Pick<PluginSettings,
  "discoveryMaxResults" | "discoveryExpansionLimit" | "discoveryCacheHours">;

const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;

/** Normalize persisted/user-entered discovery limits at every settings boundary. */
export function normalizeDiscoverySettings(settings: Partial<DiscoveryNumericSettings>): DiscoveryNumericSettings {
  return {
    discoveryMaxResults: boundedInteger(settings.discoveryMaxResults, DEFAULT_SETTINGS.discoveryMaxResults, 5, 100),
    discoveryExpansionLimit: boundedInteger(settings.discoveryExpansionLimit, DEFAULT_SETTINGS.discoveryExpansionLimit, 5, 50),
    discoveryCacheHours: boundedInteger(settings.discoveryCacheHours, DEFAULT_SETTINGS.discoveryCacheHours, 1, 168),
  };
}

/** Streaming callbacks for a single Claude request. */
export interface StreamHandlers {
  onText: (delta: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: Error) => void;
  /** Token usage reported by the provider (Anthropic only). */
  onUsage?: (usage: import("./claude/sse").TokenUsage) => void;
  /** Incremental extended-thinking text (Anthropic, when thinking is on). */
  onThinking?: (delta: string) => void;
  /** A completed `tool_use` block streamed by the model (agent mode, Anthropic only). */
  onToolUse?: (block: import("./providers/types").ToolUseBlock) => void;
  /** Called when generation stopped at the output-token limit (response truncated). */
  onTruncated?: () => void;
  /** Final stop reason when the stream ends (e.g. "end_turn", "tool_use"). */
  onStopReason?: (reason: string) => void;
}

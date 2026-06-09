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

  // ----- semantic search (local embeddings) -----
  /** Build a local vector index so the vault is searchable by meaning. */
  semanticEnabled: boolean;
  /** Ollama embedding model (e.g. nomic-embed-text). Local + private. */
  embeddingModel: string;

  // ----- indexing -----
  /** Auto-add tags + summary frontmatter when saving artifacts/chats. */
  autoTagOnSave: boolean;
  /** Tags every saved artifact gets, for reliable indexing. */
  artifactBaseTags: string[];
  /** Tags every saved chat gets. */
  chatBaseTags: string[];

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
}

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: "",
  authMode: "apiKey",
  oauthToken: "",
  baseUrl: "",
  model: "claude-sonnet-4-6",
  customModel: "",
  maxTokens: 20000,
  systemPrompt:
    "You are Claude, working inside the user's Obsidian vault. Be concise and precise. " +
    "When the user asks for a plan, report, diagram, or anything visual, prefer producing a single " +
    "self-contained HTML artifact in a ```claude-html code block using the provided design system.",
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
  maxConversations: 200,

  ollamaHost: "http://localhost:11434",
  ollamaModel: "llama3.1",
  localUtilityEnabled: false,
  chatBackend: "claude",

  semanticEnabled: false,
  embeddingModel: "nomic-embed-text",

  autoTagOnSave: true,
  artifactBaseTags: ["claude", "artifact"],
  chatBaseTags: ["claude", "chat"],

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
};

/** Streaming callbacks for a single Claude request. */
export interface StreamHandlers {
  onText: (delta: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: Error) => void;
  /** Token usage reported by the provider (Anthropic only). */
  onUsage?: (usage: import("./claude/sse").TokenUsage) => void;
  /** Incremental extended-thinking text (Anthropic, when thinking is on). */
  onThinking?: (delta: string) => void;
  /** Called when generation stopped at the output-token limit (response truncated). */
  onTruncated?: () => void;
}

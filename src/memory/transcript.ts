// Pure, Obsidian-free parsing of a Claude Code session transcript (.jsonl) into a
// structured digest: clean prose turns, the actions Claude took (files touched,
// commands run), and provenance (model, git branch, token usage, timespan).
//
// This is the *episodic-memory* extractor of the unified-memory pipeline. It only
// shapes the data — callers MUST run the text fields through ./sanitize before
// persisting anything, since tool output can contain secrets.
//
// On-disk format (one JSON record per line) seen in ~/.claude/projects/<cwd>/<id>.jsonl:
//   { type:"user"|"assistant"|"system"|..., message:{ role, content, model, usage },
//     uuid, parentUuid, timestamp, sessionId, gitBranch, cwd, isSidechain, ... }
// `message.content` is a string (user) or an array of typed blocks: text,
// thinking, tool_use {name, input}, tool_result {content}. The schema is internal
// to Claude Code and may change, so every field is read defensively.

export interface ProseTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ToolAction {
  tool: string;
  /** The primary argument: a file path, command, pattern, etc. (truncated). */
  target?: string;
}

export interface SessionDigest {
  sessionId?: string;
  model?: string;
  gitBranch?: string;
  /** Absolute working directory the session ran in (used to scope to a vault). */
  cwd?: string;
  /** ISO timestamps of the first and last record. */
  startedAt?: string;
  endedAt?: string;
  userTurns: number;
  assistantTurns: number;
  /** Clean conversational prose (harness noise + tool chatter stripped). */
  prose: ProseTurn[];
  /** Every tool invocation, in order — what Claude actually did. */
  toolActions: ToolAction[];
  /** Unique file paths created/edited/read, for linking back to the work. */
  filesTouched: string[];
  inputTokens: number;
  outputTokens: number;
}

const NOISE_PREFIXES = ["<command-", "<local-command", "<system-reminder", "Caveat:"];
const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);
const TARGET_KEYS = ["file_path", "path", "notebook_path", "command", "pattern", "query", "url"];
const MAX_TARGET = 160;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Join the text blocks of a message's content (ignoring thinking/tool blocks). */
function proseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(asRecord)
    .filter((b): b is Record<string, unknown> => !!b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function isNoise(text: string): boolean {
  const t = text.trim();
  if (t === "" || t === "[Request interrupted by user]") return true;
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

function toolTarget(name: string, input: Record<string, unknown>): string | undefined {
  const keys = FILE_TOOLS.has(name) ? ["file_path", "path", "notebook_path"] : TARGET_KEYS;
  for (const k of keys) {
    const v = str(input[k]);
    if (v) return v.length > MAX_TARGET ? `${v.slice(0, MAX_TARGET)}…` : v;
  }
  return undefined;
}

/** Parse a raw .jsonl transcript into a structured, link-ready digest. */
export function digestTranscript(jsonl: string): SessionDigest {
  const d: SessionDigest = {
    userTurns: 0,
    assistantTurns: 0,
    prose: [],
    toolActions: [],
    filesTouched: [],
    inputTokens: 0,
    outputTokens: 0,
  };
  const files = new Set<string>();

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = asRecord(JSON.parse(line));
    } catch {
      continue; // skip malformed lines — schema is best-effort
    }
    if (!rec) continue;

    const ts = str(rec.timestamp);
    if (ts) {
      if (!d.startedAt) d.startedAt = ts;
      d.endedAt = ts;
    }
    if (!d.sessionId) d.sessionId = str(rec.sessionId);
    if (!d.gitBranch) d.gitBranch = str(rec.gitBranch);
    if (!d.cwd) d.cwd = str(rec.cwd);

    const type = rec.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = asRecord(rec.message);
    if (!msg) continue;

    if (type === "assistant") {
      if (!d.model) d.model = str(msg.model);
      const usage = asRecord(msg.usage);
      if (usage) {
        d.inputTokens += num(usage.input_tokens);
        d.outputTokens += num(usage.output_tokens);
      }
    }

    const text = proseText(msg.content).trim();
    if (text && !isNoise(text)) {
      d.prose.push({ role: type, text });
      if (type === "user") d.userTurns++;
      else d.assistantTurns++;
    }

    if (Array.isArray(msg.content)) {
      for (const raw of msg.content) {
        const b = asRecord(raw);
        if (!b || b.type !== "tool_use") continue;
        const name = str(b.name);
        if (!name) continue;
        const input = asRecord(b.input) ?? {};
        d.toolActions.push({ tool: name, target: toolTarget(name, input) });
        if (FILE_TOOLS.has(name)) {
          const fp = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
          if (fp) files.add(fp);
        }
      }
    }
  }

  d.filesTouched = [...files];
  return d;
}

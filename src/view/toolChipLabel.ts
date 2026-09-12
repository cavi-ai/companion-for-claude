import { stripCliToolName } from "../cli/argv";

const QUERY_MAX = 60;
const TEXT_MAX = 80;

const QUERY_TOOLS = new Set(["vault_search", "web_search"]);
const PATH_TOOLS = new Set(["note_read", "note_append", "note_update", "note_patch", "get_backlinks", "get_outgoing_links", "note_move", "propose_note_edit"]);
const TOOL_LABELS: Record<string, string> = {
  vault_search: "Search vault",
  note_read: "Read note",
  note_create: "Create note",
  note_append: "Append to note",
  note_update: "Update note",
  note_patch: "Update note",
  propose_note_edit: "Propose edit",
  get_backlinks: "Find backlinks",
  get_outgoing_links: "Find outgoing links",
  note_move: "Move note",
  web_search: "Search web",
  web_fetch: "Read webpage",
};

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function field(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Old fallback: the raw JSON args, truncated. "" for no/empty input. */
function fallback(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "object" && Object.keys(input).length === 0) return "";
  return cap(JSON.stringify(input), TEXT_MAX);
}

function host(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Per-tool argument summary: the query/path/title that matters, not the raw JSON. */
export function formatToolArgs(name: string, input: unknown): string {
  if (typeof input === "string") {
    const str = input;
    try {
      input = JSON.parse(str);
    } catch {
      return cap(str, TEXT_MAX);
    }
  }
  const bare = stripCliToolName(name);

  if (QUERY_TOOLS.has(bare)) {
    const q = field(input, "query");
    return q ? `"${cap(q, QUERY_MAX)}"` : fallback(input);
  }
  if (PATH_TOOLS.has(bare)) {
    const p = field(input, "path");
    return p ? cap(p, TEXT_MAX) : fallback(input);
  }
  if (bare === "note_create") {
    const t = field(input, "title");
    return t ? cap(t, TEXT_MAX) : fallback(input);
  }
  if (bare === "frontmatter_query") {
    const f = field(input, "field");
    if (!f) return fallback(input);
    const v = field(input, "value");
    return v ? `${cap(f, TEXT_MAX)} = ${cap(v, TEXT_MAX)}` : cap(f, TEXT_MAX);
  }
  if (bare === "web_fetch") {
    const u = field(input, "url");
    const h = u ? host(u) : undefined;
    return h ?? fallback(input);
  }
  if (bare.startsWith("research_")) {
    const p = field(input, "project") ?? field(input, "path");
    return p ? cap(p, TEXT_MAX) : fallback(input);
  }
  return fallback(input);
}

/** Compact one-line chip label: tool name + formatted args (empty args omitted).
 *  Strips the chat-bridge's own MCP prefix so it reads as the bare tool name;
 *  user-configured external MCP servers keep their `mcp__<server>__` names. */
export function chipLabel(name: string, input: unknown): string {
  const bare = stripCliToolName(name);
  const label = bare.startsWith("mcp__")
    ? bare
    : TOOL_LABELS[bare] ?? bare.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  let args = formatToolArgs(name, input);
  if (PATH_TOOLS.has(bare)) {
    let parsed = input;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { /* keep the diagnostic fallback */ }
    }
    const path = field(parsed, "path");
    if (path) args = path.split("/").at(-1)?.replace(/\.md$/i, "") ?? args;
  }
  return args ? `${label} — ${args}` : label;
}

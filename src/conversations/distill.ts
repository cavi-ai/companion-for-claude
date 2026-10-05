// Pure distillation of a chat into a summary note: the model input is a scrubbed
// transcript (no tool output, no artifact HTML) and the reply is schema-validated.

import type { ChatMessage } from "../types";
import { extractArtifact } from "../artifacts/parse";
import { sanitizeWithReport } from "../memory/sanitize";
import { buildFrontmatter } from "../indexing/frontmatter";

export interface Distilled {
  title: string;
  summary: string;
  decisions: string[];
  facts: string[];
  openItems: string[];
}

const TITLE_MAX = 80;
const LIST_MAX = 20;
const INPUT_HEAD = 4_000;
const INPUT_TAIL = 20_000;
const INPUT_CAP = INPUT_HEAD + INPUT_TAIL;
const OMITTED = "…[middle omitted]…";
const NOTES_MAX = 30;

const listSchema = { type: "array", items: { type: "string" }, maxItems: LIST_MAX };

export const DISTILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: TITLE_MAX },
    summary: { type: "string" },
    decisions: listSchema,
    facts: listSchema,
    openItems: listSchema,
  },
  required: ["title", "summary", "decisions", "facts", "openItems"],
  additionalProperties: false,
};

export const DISTILL_SYSTEM = [
  "Summarize the conversation for a personal knowledge base.",
  "Capture what was decided, durable facts worth remembering, and what is still open. Ignore tool noise, pleasantries, and artifact markup.",
  `Return JSON only, matching the schema: title (at most ${TITLE_MAX} characters), summary (a short paragraph), decisions, facts, openItems (each at most ${LIST_MAX} short strings; empty array when none).`,
].join("\n");

const ARTIFACT_BLOCK_RE = /```(?:claude-html|codex-html)[^\n]*\n[\s\S]*?```/gi;

function withoutArtifacts(content: string): { text: string; hadText: boolean } {
  const text = content.replace(ARTIFACT_BLOCK_RE, (block) => `[artifact: ${extractArtifact(block)?.title ?? "untitled"}]`);
  return { text, hadText: content.replace(ARTIFACT_BLOCK_RE, "").trim().length > 0 };
}

export function distillInput(messages: ChatMessage[]): { text: string; redactions: number } {
  const turns: string[] = [];
  for (const message of messages) {
    if (message.contextExcluded) continue;
    const { text, hadText } = withoutArtifacts(message.content);
    if (!hadText) continue;
    turns.push(`${message.role === "user" ? "User" : "Claude"}: ${text.trim()}`);
  }
  if (turns.length === 0) return { text: "", redactions: 0 };
  const scrubbed = sanitizeWithReport(turns.join("\n\n"));
  const redactions = scrubbed.redactions.reduce((sum, r) => sum + r.count, 0);
  const text = scrubbed.text.length > INPUT_CAP
    ? `${scrubbed.text.slice(0, INPUT_HEAD)}\n${OMITTED}\n${scrubbed.text.slice(-INPUT_TAIL)}`
    : scrubbed.text;
  return { text, redactions };
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`"${field}" must be an array of strings`);
  if (value.length > LIST_MAX) throw new Error(`"${field}" has more than ${LIST_MAX} items`);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`"${field}" must contain only non-empty strings`);
    return item.trim();
  });
}

function jsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new Error("The response was not valid JSON");
  }
}

export function parseDistill(raw: string): Distilled {
  const value = jsonObject(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The response was not a JSON object");
  const o = value as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (title.length === 0) throw new Error('"title" is required');
  if (title.length > TITLE_MAX) throw new Error(`"title" is longer than ${TITLE_MAX} characters`);
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (summary.length === 0) throw new Error('"summary" is required');
  return {
    title,
    summary,
    decisions: stringList(o.decisions, "decisions"),
    facts: stringList(o.facts, "facts"),
    openItems: stringList(o.openItems, "openItems"),
  };
}

const PATH_TOOLS = /^(?:note_|base_create$|canvas_create$|propose_note_edit$)/;
const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

function pathsOfArgs(argsSummary: string): string[] {
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return [record.path, record.to].filter((v): v is string => typeof v === "string");
    }
  } catch { /* a plain path string */ }
  return [argsSummary];
}

/** Existing vault notes the chat read, wrote, or linked, deduped in first-use order; `resolve` maps a path or link to a vault path, or null. */
export function notesTouched(messages: ChatMessage[], resolve: (linkOrPath: string) => string | null): string[] {
  const out: string[] = [];
  const add = (candidate: string): void => {
    const raw = candidate.trim();
    if (raw.length === 0 || out.length >= NOTES_MAX) return;
    const path = resolve(raw);
    if (path !== null && !out.includes(path)) out.push(path);
  };
  for (const message of messages) {
    for (const entry of message.toolTrace ?? []) {
      if (PATH_TOOLS.test(entry.name)) pathsOfArgs(entry.argsSummary).forEach(add);
    }
    for (const match of message.content.matchAll(WIKILINK_RE)) {
      const target = (match[1] ?? "").trim();
      add(target.replace(/\.md$/, ""));
    }
  }
  return out;
}

function bullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

export function renderDistilledNote(
  d: Distilled,
  meta: { conversationId: string; created: string; notes: string[]; tags: string[] },
): string {
  const fm = buildFrontmatter({
    title: d.title,
    created: meta.created,
    source: "claude-companion",
    type: "chat-summary",
    summary: d.summary,
    tags: meta.tags,
    conversation: meta.conversationId,
  });
  const sections: Array<[string, string[]]> = [
    ["Summary", [d.summary]],
    ["Decisions", bullets(d.decisions)],
    ["Facts", bullets(d.facts)],
    ["Open items", bullets(d.openItems)],
    ["Notes touched", meta.notes.map((path) => `- [[${path.replace(/\.md$/, "")}]]`)],
  ];
  const body = sections.filter(([, lines]) => lines.length > 0).flatMap(([name, lines]) => [`## ${name}`, "", ...lines, ""]);
  return [fm, "", `# ${d.title}`, "", ...body].join("\n");
}

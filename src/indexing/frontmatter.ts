// Pure helpers for building YAML frontmatter and normalizing tags, so artifacts
// and chats are indexed correctly by Obsidian's tag pane, Dataview, and search.

export function normalizeTag(raw: string): string {
  // Obsidian tags: no leading '#', spaces → '-', only [A-Za-z0-9_/-], no leading digit-only.
  let t = raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_/-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // A tag cannot be purely numeric; prefix if so.
  if (/^[0-9/_-]+$/.test(t) && t.length > 0) t = `t-${t}`;
  return t;
}

export function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Quote a YAML scalar only when needed. */
function yamlScalar(v: string): string {
  if (v === "" || /[:#[\]{}&*!|>'"%@`,]/.test(v) || /^\s|\s$/.test(v) || /^(true|false|null|yes|no)$/i.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

export interface FrontmatterData {
  [key: string]: string | number | boolean | string[] | undefined;
}

/**
 * Build a dated, human-readable note base name: "YYYY-MM-DD — Title". Keeps saved
 * notes sorted by day and titled meaningfully, instead of named after the prompt.
 * Accepts a full ISO timestamp or a YYYY-MM-DD date.
 */
export function datedTitleBase(dateISO: string, title: string): string {
  const date = (dateISO || "").slice(0, 10) || "undated";
  const clean = title.trim().replace(/\s+/g, " ") || "Untitled";
  return `${date} — ${clean}`;
}

/** Serialize a flat frontmatter object to a YAML block (with --- fences). */
export function buildFrontmatter(data: FrontmatterData): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse a model "tag line" — Claude/Ollama are asked to return comma- or
 * space-separated keywords. Accepts "#tag, foo bar, baz" forms.
 */
export function parseTagSuggestions(text: string, max = 8): string[] {
  const candidates = text
    .replace(/^[\s\-*•]+/gm, " ")
    .split(/[,\n]/)
    .flatMap((chunk) => chunk.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  return normalizeTags(candidates).slice(0, max);
}

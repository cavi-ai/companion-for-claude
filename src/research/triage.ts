// Clippings triage (Research Desk): group an inbox of raw clippings into
// coherent research themes with one model call, then render a triage board
// note the desk can act on. Pure and dependency-free.

export interface TriageNote {
  path: string;
  title: string;
  type: string;
  url?: string;
  tags: string[];
  /** Short plain-text excerpt (frontmatter stripped, whitespace collapsed). */
  excerpt: string;
}

export interface TriageGroup {
  theme: string;
  summary: string;
  researchIdea: string;
  paths: string[];
}

export const TRIAGE_SYSTEM = [
  "You organize a researcher's clipping inbox into coherent research themes.",
  "Group the clippings by topic, methodology, or question — whatever makes them most useful as research material.",
  "For each theme, suggest one research idea the clippings could seed.",
  "A clipping may appear in at most one group. Skip clippings that are pure noise.",
  "Return ONLY JSON matching the requested shape — no prose, no code fences.",
].join(" ");

const MAX_TRIAGE_NOTES = 60;
const MAX_GROUPS = 8;

export function buildTriageUser(notes: TriageNote[]): string {
  const listed = notes.slice(0, MAX_TRIAGE_NOTES).map((n) => ({
    path: n.path,
    title: n.title,
    type: n.type,
    ...(n.url ? { url: n.url } : {}),
    ...(n.tags.length ? { tags: n.tags } : {}),
    excerpt: n.excerpt.slice(0, 300),
  }));
  return [
    "Group these clippings into research themes.",
    'Return JSON: { "groups": [ { "theme": string, "summary": string, "researchIdea": string, "paths": string[] } ] }',
    `At most ${MAX_GROUPS} groups. paths must be copied exactly from the input.`,
    "",
    JSON.stringify(listed, null, 2),
  ].join("\n");
}

/** Parse the model's grouping, dropping unknown paths, empty groups, and duplicates. */
export function parseTriageResponse(raw: string, validPaths: Set<string>): TriageGroup[] {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Triage response was not JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Triage response was not valid JSON.");
  }
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) throw new Error("Triage response had no groups array.");

  const seen = new Set<string>();
  const out: TriageGroup[] = [];
  for (const g of groups.slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== "object") continue;
    const group = g as Record<string, unknown>;
    const theme = typeof group.theme === "string" ? group.theme.trim() : "";
    const paths = Array.isArray(group.paths)
      ? group.paths.filter((p): p is string => typeof p === "string" && validPaths.has(p) && !seen.has(p)).map((p) => { seen.add(p); return p; })
      : [];
    if (!theme || paths.length === 0) continue;
    out.push({
      theme,
      summary: typeof group.summary === "string" ? group.summary.trim() : "",
      researchIdea: typeof group.researchIdea === "string" ? group.researchIdea.trim() : "",
      paths,
    });
  }
  return out;
}

/** Theme → a single vault-safe tag, nested under `research/`. */
export function themeTagSlug(theme: string): string {
  const slug = theme.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `research/${slug || "untriaged"}`;
}

/**
 * Render the triage board. Frontmatter carries `source_enriched: true` so the
 * inbox watcher never tries to re-enrich the board itself.
 */
export function renderTriageNote(groups: TriageGroup[], notesByPath: Map<string, TriageNote>, generatedAt: string): string {
  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  const lines: string[] = [
    "---",
    "title: Clippings triage",
    "type: triage",
    "source_enriched: true",
    `generated: ${generatedAt.slice(0, 10)}`,
    "tags:",
    "  - research/triage",
    "---",
    "",
    "# Clippings triage",
    "",
    `_${total} clippings grouped into ${groups.length} theme${groups.length === 1 ? "" : "s"}. Re-run Triage from the Research Desk after new clips arrive._`,
    "",
  ];
  for (const group of groups) {
    lines.push(`## ${group.theme}`, "");
    if (group.summary) lines.push(group.summary, "");
    if (group.researchIdea) lines.push(`**Potential project:** ${group.researchIdea}`, "");
    for (const path of group.paths) {
      const note = notesByPath.get(path);
      const title = note?.title ?? path;
      lines.push(`- [[${path}|${title}]]${note?.url ? ` — [source](${note.url})` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Plain-text excerpt of a note body: frontmatter stripped, whitespace collapsed. */
export function noteExcerpt(content: string, max = 400): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.replace(/[\]#>*`[]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

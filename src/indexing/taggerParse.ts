import { parseTagSuggestions } from "./frontmatter";

/** Pure parser for the tagger model's three-line output. Obsidian-free for tests. */
export function parseTaggerOutput(raw: string): { tags: string[]; summary: string; title: string } {
  let tags: string[] = [];
  let summary = "";
  let title = "";
  for (const line of raw.split("\n")) {
    const t = /^\s*title\s*:\s*(.+)$/i.exec(line);
    const m = /^\s*tags\s*:\s*(.+)$/i.exec(line);
    const s = /^\s*summary\s*:\s*(.+)$/i.exec(line);
    if (t?.[1]) title = t[1].trim().replace(/^["']|["']$/g, "").replace(/[.?!]+$/, "").trim();
    else if (m?.[1]) tags = parseTagSuggestions(m[1]);
    else if (s?.[1]) summary = s[1].trim();
  }
  // Fallback: if the model ignored the format, treat the whole thing as tags.
  if (tags.length === 0) tags = parseTagSuggestions(raw);
  return { tags, summary, title };
}

// Pure (Obsidian-free) helpers for the per-note "/frontmatter" suggestion: the
// utility-model prompt and the parser for its reply. Kept separate from the
// Obsidian glue so it can be unit-tested directly.

export interface FrontmatterSuggestion {
  /** Best-fitting ontology type, when a type list was offered and one fit. */
  type?: string;
  /** Lowercase, hyphenated topic tags (no leading #). */
  tags: string[];
  /** One-sentence summary. */
  summary: string;
}

/**
 * System prompt for the suggestion. When `typeOptions` is non-empty the model
 * must pick one (exact spelling) or "-"; otherwise the type line is a no-op so
 * we never invent a type when the vault has no ontology.
 */
export function frontmatterSuggestSystem(typeOptions: string[]): string {
  const typeLine =
    typeOptions.length > 0
      ? `TYPE: the single best-fitting type from this exact list, or "-" if none fit: ${typeOptions.join(", ")}\n`
      : "TYPE: -\n";
  return (
    "You are a precise knowledge-base indexer. Reply with EXACTLY these three lines and nothing else:\n" +
    typeLine +
    "TAGS: 4-8 lowercase topic tags, comma-separated, no # symbol, use-hyphens-for-spaces (prefer reusing the provided existing tags when they fit)\n" +
    "SUMMARY: one concise sentence describing the note's content (max 25 words, no quotes)."
  );
}

/** Parse the model's `TYPE:`/`TAGS:`/`SUMMARY:` reply. Tolerant of extra prose. */
export function parseFrontmatterSuggestion(raw: string): FrontmatterSuggestion {
  const field = (label: string): string => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im").exec(raw);
    return m?.[1]?.trim() ?? "";
  };
  const typeRaw = field("TYPE");
  const type = typeRaw && typeRaw !== "-" ? typeRaw : undefined;
  const tags = Array.from(
    new Set(
      field("TAGS")
        .split(",")
        .map((t) => t.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-"))
        .filter((t) => t.length > 0),
    ),
  );
  const summary = field("SUMMARY");
  return { ...(type ? { type } : {}), tags, summary };
}

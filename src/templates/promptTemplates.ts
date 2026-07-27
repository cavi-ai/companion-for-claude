// User-defined prompt templates (spec 2026-07-22 user-value roadmap, §6).
// A template is a markdown note in the templates folder: frontmatter carries
// the name/description/optional defaults (model, context toggles), the body is
// the prompt. {selection} and {active_note} placeholders are substituted at run
// time; unknown placeholders are left literal. Pure — vault IO lives upstream.

import type { ContextToggles } from "../types";

export interface PromptTemplate {
  /** Slash token (lowercase, dashes) derived from the name or file basename. */
  name: string;
  /** One-liner for the palette; falls back to the first body line. */
  description: string;
  /** The prompt body (note content minus frontmatter). */
  prompt: string;
  /** Optional model override for the turn. */
  model?: string;
  /** Optional context-toggle overrides for the turn. */
  context?: Partial<ContextToggles>;
  /** Vault path of the backing note (for debugging/future edit affordances). */
  path: string;
}

/** Turn a display name into a slash token: "Standup Summary" → "standup-summary". */
export function slugifyTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const CONTEXT_KEYS: (keyof ContextToggles)[] = ["activeNote", "selection", "linkedNotes", "searchVault"];

/**
 * Parse one template note. `frontmatter` is the parsed YAML object ({} when the
 * note has none); `body` is the note content with frontmatter already stripped.
 * Returns null when the note is unusable (empty body, or a name that slugifies
 * to nothing).
 */
export function parseTemplateNote(path: string, basename: string, frontmatter: Record<string, unknown>, body: string): PromptTemplate | null {
  const prompt = body.trim();
  if (!prompt) return null;
  const rawName = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : basename;
  const name = slugifyTemplateName(rawName);
  if (!name) return null;
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const description =
    typeof frontmatter.description === "string" && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : firstLine.length > 80
        ? `${firstLine.slice(0, 77)}…`
        : firstLine;

  const template: PromptTemplate = { name, description, prompt, path };

  if (typeof frontmatter.model === "string" && frontmatter.model.trim()) template.model = frontmatter.model.trim();

  const ctx = frontmatter.context;
  if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
    const overrides: Partial<ContextToggles> = {};
    for (const key of CONTEXT_KEYS) {
      const v = (ctx as Record<string, unknown>)[key];
      if (typeof v === "boolean") overrides[key] = v;
    }
    if (Object.keys(overrides).length > 0) template.context = overrides;
  }

  return template;
}

export interface PlaceholderValues {
  /** Current editor selection (empty when there is none). */
  selection?: string;
  /** Full text of the active note (empty when there is none). */
  activeNote?: string;
}

/**
 * Substitute {selection} and {active_note}. Unknown placeholders stay literal
 * so a template can mention e.g. JSON examples without being mangled. A
 * placeholder with no available value resolves to an empty string.
 */
export function substitutePlaceholders(prompt: string, values: PlaceholderValues): string {
  return prompt
    .replace(/\{selection\}/g, values.selection?.trim() ?? "")
    .replace(/\{active_note\}/g, values.activeNote ?? "");
}

/** The scaffold note written by the "Create prompt template" command. */
export const TEMPLATE_SCAFFOLD = `---
name: My template
description: One line on what this prompt does
# model: claude-sonnet-5        # optional per-turn model override
# context:                      # optional per-turn context toggles
#   searchVault: true
#   activeNote: true
---
Write the prompt here. Placeholders substituted when the command runs:

- {selection} — the current editor selection (empty if none)
- {active_note} — the full text of the active note

Any other {placeholder} is left as-is.
`;

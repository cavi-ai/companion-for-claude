// The inline-rewrite model (roadmap Track B): build a chat-free rewrite
// request for the selected text and normalize the model's answer back into
// plain markdown. Pure and dependency-free.

export interface RewritePreset {
  id: string;
  label: string;
  instruction: string;
}

export const REWRITE_PRESETS: RewritePreset[] = [
  { id: "improve", label: "Improve writing", instruction: "Improve clarity, flow, and word choice while preserving the author's voice and meaning." },
  { id: "grammar", label: "Fix grammar & spelling", instruction: "Fix grammar, spelling, and punctuation only. Do not change wording, tone, or structure." },
  { id: "shorten", label: "Shorten", instruction: "Make it noticeably shorter while keeping every key point." },
  { id: "expand", label: "Expand", instruction: "Expand with supporting detail and examples, staying on-topic and in the author's voice." },
  { id: "simplify", label: "Simplify", instruction: "Rewrite in simpler, plainer language a broad audience can follow." },
  { id: "formal", label: "Make formal", instruction: "Rewrite in a formal, professional tone." },
  { id: "casual", label: "Make casual", instruction: "Rewrite in a relaxed, conversational tone." },
];

export const REWRITE_SYSTEM = [
  "You rewrite markdown text from an Obsidian note.",
  "Return ONLY the rewritten text — no preamble, no explanation, no wrapping quotes, no code fences around prose.",
  "Preserve markdown syntax, wiki-links ([[...]]), URLs, footnotes, and any real code blocks.",
  "If the selection is a list, heading, or quote, keep that structure.",
  "Write in the same language as the original unless the instruction says otherwise.",
].join(" ");

export function buildRewriteUser(selection: string, instruction: string): string {
  return `Instruction: ${instruction}\n\nText to rewrite:\n${selection}`;
}

/**
 * Grounded variant (Research Desk): the rewrite must stay within the supplied
 * grounding context — evidence excerpts, claim text, etc. The model may
 * rephrase and tighten, never introduce facts the context doesn't support.
 */
export function buildGroundedRewriteUser(selection: string, instruction: string, context: string): string {
  return [
    `Instruction: ${instruction}`,
    "",
    "Grounding context (rephrase only what this supports — introduce no new facts, citations, or claims beyond it):",
    context,
    "",
    "Text to rewrite:",
    selection,
  ].join("\n");
}

/** Rough char→token budget with headroom for expansions; bounded so a huge
 *  selection doesn't blow past the model's output limit. */
export function rewriteMaxTokens(selection: string): number {
  return Math.min(8000, Math.max(600, Math.ceil(selection.length / 2)));
}

/**
 * Normalize the raw completion into replacement text. Unwraps a single
 * whole-answer code fence the model may add despite instructions (only when
 * the original had no fences), and rejects empty / no-op answers.
 */
export function parseRewrite(raw: string, selection: string): string {
  let text = raw.trim();
  if (!selection.includes("```")) {
    const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
    if (fenced) text = fenced[1]!.trim();
  }
  if (text.length === 0) throw new Error("The model returned an empty rewrite — try rephrasing the instruction.");
  if (text === selection.trim()) throw new Error("The model returned the text unchanged.");
  return text;
}

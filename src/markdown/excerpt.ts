// Plain prose from a note for model prompts: frontmatter and fenced code
// dropped, clipped by code point. Pure.

import { fencedLines } from "./fences";
import { stripFrontmatter } from "./frontmatter";

/** At most `max` code points of `text`. */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** The note's lines outside frontmatter and fenced code; a leading BOM is ignored. */
export function proseLines(content: string): string[] {
  const lines = stripFrontmatter(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/);
  const fenced = fencedLines(lines);
  return lines.filter((_, i) => !fenced[i]);
}

/** One line of prose: Markdown punctuation and runs of whitespace collapsed to single spaces, at most `max` code points. */
export function noteExcerpt(content: string, max: number): string {
  return clipChars(proseLines(content).join(" ").replace(/[\]#>*`[]/g, " ").replace(/\s+/g, " ").trim(), max);
}

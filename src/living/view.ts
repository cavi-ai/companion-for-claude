// Living view notes: which sources get one, where it lives, and the binding it
// records (source link, kind, fingerprint, build time) in its frontmatter. Pure.

import { buildFrontmatter, normalizeTags } from "../indexing/frontmatter";
import { sanitizeFileName } from "../artifacts/parse";

export type LivingKind = "argument-map" | "dataset-explorer" | "chapter-map";

export const KIND_LABEL: Record<LivingKind, string> = {
  "argument-map": "argument map",
  "dataset-explorer": "dataset explorer",
  "chapter-map": "chapter map",
};

const isLivingKind = (kind: string): kind is LivingKind => Object.prototype.hasOwnProperty.call(KIND_LABEL, kind);

/** Code-block language of the status row at the top of a view note. */
export const LIVING_STATUS_LANGUAGE = "claude-living";
export const VIEW_TYPE = "living-view";
const VIEW_HEIGHT = 720;

/** The view a source note gets: an article maps its argument, a video its chapters, and a dataset with a CSV asset gets an explorer. */
export function livingKindFor(frontmatter: Record<string, unknown> | undefined): LivingKind | null {
  if (!frontmatter || frontmatter.type === VIEW_TYPE) return null;
  if (frontmatter.type === "article") return "argument-map";
  if (frontmatter.type === "video") return "chapter-map";
  if (frontmatter.type === "dataset" && typeof frontmatter.asset === "string" && /\.csv$/i.test(frontmatter.asset.trim())) return "dataset-explorer";
  return null;
}

/** Where a source's view lives by default: `<folder>/Living views/<source> — <kind>.md`. */
export function defaultViewPath(folder: string, sourceBasename: string, kind: LivingKind): string {
  const base = folder.replace(/\/+$/, "");
  return `${base ? `${base}/` : ""}Living views/${sanitizeFileName(sourceBasename)} — ${KIND_LABEL[kind]}.md`;
}

export interface LivingBinding {
  /** Link text of the source note, as written inside [[ ]]. */
  source: string;
  kind: LivingKind;
  hash: string;
  generated: string;
}

export interface ViewNoteInput extends LivingBinding {
  title: string;
  html: string;
  /** Markdown after the page, for links that must open outside the sandboxed frame. */
  after?: string;
}

/** The view note: binding frontmatter, the status row, the generated page, then any markdown after it. */
export function buildViewNote(input: ViewNoteInput): string {
  const fm = buildFrontmatter({
    title: input.title,
    type: VIEW_TYPE,
    source: "claude-companion",
    living_source: `[[${input.source}]]`,
    living_kind: input.kind,
    living_hash: input.hash,
    living_generated: input.generated,
    tags: normalizeTags(["claude", "living-view"]),
  });
  const after = input.after?.trim() ? [input.after.trim(), ""] : [];
  return [fm, "", "```" + LIVING_STATUS_LANGUAGE, "```", "", "```claude-html height=" + VIEW_HEIGHT, input.html, "```", "", ...after].join("\n");
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** The binding recorded in a view note's text, or null when it is not a complete living view. */
export function readBinding(note: string): LivingBinding | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note);
  if (!match) return null;
  const field = (key: string): string => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(match[1]!);
    return line ? unquote(line[1]!) : "";
  };
  const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(field("living_source"))?.[1]?.trim();
  const kind = field("living_kind");
  const hash = field("living_hash");
  if (!link || !hash || !isLivingKind(kind)) return null;
  return { source: link, kind, hash, generated: field("living_generated") };
}

/** Note text without its frontmatter block. */
export function noteBody(note: string): string {
  return note.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

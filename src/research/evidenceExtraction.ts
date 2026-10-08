import type { ResearchSourceRecord, SourceLocatorKind } from "./types";
import { stripFrontmatter } from "../markdown/frontmatter";
import { replyJson } from "../providers/replyJson";
import { isRecord } from "../records";

export interface SourceText { text: string; pages?: Array<{ page: number; text: string }> }
export interface ProposedPassage { title: string; excerpt: string; locatorKind: SourceLocatorKind; locatorValue: string; interpretation?: string }

export interface SourceTextIo {
  readPdfPages(assetPath: string): Promise<Array<{ page: number; text: string }> | null>;
  readNote(path: string): Promise<string | null>;
}

/** Text Claude can read for a source: its capture, else its PDF pages, else the source note's own body. */
export async function resolveSourceText(source: Pick<ResearchSourceRecord, "path" | "asset" | "capturedContent">, io: SourceTextIo): Promise<SourceText | null> {
  if (typeof source.capturedContent === "string" && source.capturedContent.trim()) return { text: source.capturedContent };
  if (source.asset?.toLowerCase().endsWith(".pdf")) {
    const pages = await io.readPdfPages(source.asset);
    if (pages?.length) return { text: pages.map(({ text }) => text).join("\n\n"), pages };
  }
  const note = await io.readNote(source.path);
  const body = note === null ? undefined : stripFrontmatter(note).trim();
  return body ? { text: body } : null;
}

export const EXTRACTION_CHAR_LIMIT = 80_000;
const MAX_PASSAGES = 5;
const STOPWORDS = new Set(["what", "which", "that", "this", "with", "from", "have", "does", "about", "their", "there", "where", "when", "will", "would", "could", "should", "into", "than", "then", "them", "they", "been", "were", "your", "more", "most", "some", "such"]);

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
const normalize = (value: string): string => collapse(quotes(value));

function questionWords(question: string): Set<string> {
  return new Set((question.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !STOPWORDS.has(word)));
}

export function fitSourceText(text: string, question: string, limit = EXTRACTION_CHAR_LIMIT): { text: string; trimmed: boolean } {
  if (text.length <= limit) return { text, trimmed: false };
  const words = questionWords(question);
  const scored = text.split(/\n\s*\n/).map((paragraph, index) => {
    const found = new Set((paragraph.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => words.has(word)));
    return { paragraph, index, score: found.size };
  });
  const byScore = [...scored].sort((left, right) => right.score - left.score || left.index - right.index);
  const kept: typeof scored = [];
  let used = 0;
  for (const item of byScore) {
    const cost = item.paragraph.length + 2;
    if (used + cost > limit) continue;
    kept.push(item);
    used += cost;
  }
  return { text: kept.sort((left, right) => left.index - right.index).map(({ paragraph }) => paragraph).join("\n\n"), trimmed: true };
}

export function buildExtractionRequest(input: { question: string; sourceTitle: string; text: string; trimmed: boolean }): { system: string; user: string } {
  const system = [
    "You pull exact passages from a source for a research project.",
    'Reply with JSON only: {"passages":[{"title":"short label","excerpt":"exact quote","interpretation":"one sentence on why it matters for the question"}]}.',
    `Give up to ${MAX_PASSAGES} passages, most relevant first.`,
    "Copy each excerpt exactly from the source text, 1 to 3 sentences. Never invent or reword a quote.",
  ].join("\n");
  const user = [
    `Research question: ${input.question}`,
    `Source: ${input.sourceTitle}`,
    ...(input.trimmed ? ["Note: the source was long, so only its most relevant parts are shown."] : []),
    "Source text:",
    input.text,
  ].join("\n\n");
  return { system, user };
}

function pageOf(excerpt: string, pages: NonNullable<SourceText["pages"]>): number | undefined {
  const needle = normalize(excerpt);
  return pages.find(({ text }) => normalize(text).includes(needle))?.page;
}

const quotes = (value: string): string => value.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D\u201F]/g, '"');

function findInText(excerpt: string, text: string): { index: number; found: string } | null {
  const needle = collapse(quotes(excerpt));
  if (!needle) return null;
  const pattern = new RegExp(needle.split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  const match = pattern.exec(quotes(text));
  return match ? { index: match.index, found: collapse(text.slice(match.index, match.index + match[0].length)) } : null;
}

export function locatePassage(excerpt: string, source: SourceText): { locatorKind: SourceLocatorKind; locatorValue: string } | null {
  if (source.pages?.length) {
    const page = pageOf(excerpt, source.pages);
    if (page !== undefined) return { locatorKind: "page", locatorValue: String(page) };
  }
  const hit = findInText(excerpt, source.text);
  if (!hit) return null;
  const before = source.text.slice(0, hit.index);
  const heading = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)].pop()?.[1]?.trim();
  if (heading) return { locatorKind: "section", locatorValue: heading };
  return { locatorKind: "paragraph", locatorValue: String(before.split(/\n\s*\n/).length) };
}

function trimTitle(raw: string, excerpt: string): string {
  const title = collapse(raw);
  if (!title) return collapse(excerpt).split(" ").slice(0, 8).join(" ");
  if (title.length <= 80) return title;
  const cut = title.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

export function parseExtraction(raw: string, source: SourceText, existingExcerpts: readonly string[]): ProposedPassage[] {
  const parsed = replyJson(raw, (value) => isRecord(value) && Array.isArray(value.passages)) as { passages: unknown[] } | undefined;
  if (!parsed) return [];
  const haystack = normalize(source.text);
  const seen = new Set(existingExcerpts.map(normalize));
  const out: ProposedPassage[] = [];
  for (const item of parsed.passages) {
    if (!item || typeof item !== "object") continue;
    const { title, excerpt, interpretation } = item as Record<string, unknown>;
    if (typeof excerpt !== "string") continue;
    const key = normalize(excerpt);
    if (!key || !haystack.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const clean = findInText(excerpt, source.text)?.found ?? collapse(excerpt);
    const where = locatePassage(clean, source) ?? { locatorKind: "quote" as const, locatorValue: clean.slice(0, 60) };
    const note = typeof interpretation === "string" ? collapse(interpretation) : "";
    out.push({ title: trimTitle(typeof title === "string" ? title : "", clean), excerpt: clean, ...where, ...(note ? { interpretation: note } : {}) });
    if (out.length >= MAX_PASSAGES) break;
  }
  return out;
}

// Enrichment for research-source notes: the same summary / key points / topics
// the inbox clip pipeline produces, extracted from the note's captured content
// (or abstract) and merged additively — `type: research-source` and the other
// research keys are never touched. Pure; the model call is injected.

import type { SourceTypeSchema } from "../sources/types";
import { extractFields, type ExtractDeps } from "../sources/extract";
import { sanitize } from "../memory/sanitize";
import { readFrontmatter, stripFrontmatter } from "../markdown/frontmatter";
import { parseYaml } from "obsidian";

export interface ResearchSourceEnrichment {
  summary: string;
  topics?: string[];
  key_claims?: string[];
}

/** Research sources need only the knowledge fields — never title/site identity. */
const RESEARCH_SCHEMA: SourceTypeSchema = {
  type: "article",
  version: 1,
  fields: [
    { key: "summary", type: "string", required: true, source: "model", description: "concise summary, maximum 200 characters" },
    { key: "topics", type: "string[]", required: false, source: "model", description: "3-6 short topic tags" },
    { key: "key_claims", type: "string[]", required: false, source: "model", description: "up to 3 key claims, one short sentence each" },
  ],
};

const MIN_SOURCE_TEXT = 200;

/** Payload of the length-addressed `cavi:capture` block, exactly as written. */
export function capturedTextFromBody(body: string): string | null {
  const match = /<!-- cavi:capture version=1 chars=(\d+) -->\n/.exec(body);
  if (!match) return null;
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length)) return null;
  const start = match.index + match[0].length;
  const end = start + length;
  if (end > body.length) return null;
  return body.slice(start, end);
}

/** The text worth summarizing: captured page content, else the abstract. */
export function researchSourceText(content: string): string | null {
  const captured = capturedTextFromBody(stripFrontmatter(content))?.trim();
  if (captured && captured.length >= MIN_SOURCE_TEXT) return captured;
  const abstract = readFrontmatter(content, (yaml) => parseYaml(yaml) as unknown)?.abstract;
  if (typeof abstract === "string" && abstract.trim().length >= MIN_SOURCE_TEXT) return abstract.trim();
  return null;
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((v) => sanitize(String(v)).trim()).filter((v) => v.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * Extract summary/topics/key_claims for a research-source note, or null when
 * there is nothing to enrich (already summarized, or too little source text).
 */
export async function extractResearchSourceEnrichment(
  input: { content: string },
  deps: ExtractDeps,
): Promise<ResearchSourceEnrichment | null> {
  const frontmatter = readFrontmatter(input.content, (yaml) => parseYaml(yaml) as unknown);
  const existing = frontmatter?.summary;
  if (typeof existing === "string" && existing.trim().length > 0) return null;
  const text = researchSourceText(input.content);
  if (!text) return null;
  const { fields } = await extractFields(RESEARCH_SCHEMA, text, {}, deps, 2);
  const summary = typeof fields.summary === "string" ? sanitize(fields.summary).trim() : "";
  if (!summary) return null;
  const topics = cleanList(fields.topics);
  const keyClaims = cleanList(fields.key_claims);
  return {
    summary,
    ...(topics ? { topics } : {}),
    ...(keyClaims ? { key_claims: keyClaims } : {}),
  };
}

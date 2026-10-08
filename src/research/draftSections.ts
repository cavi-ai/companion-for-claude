import { fnv1aFingerprint } from "../hashing";
import { fencedLines } from "../markdown/fences";
import { isRecord } from "../records";

export interface DraftSectionEnvelope {
  id: string;
  claimPaths: string[];
  evidence: Array<{ path: string; fingerprint: string }>;
  citations: Array<{ key: string; sourcePath: string }>;
  provider: string;
  model: string;
  generatedAt: string;
  claimFingerprint?: string;
  revisionIntent?: string;
  revisionInstruction?: string;
  revisedFromFingerprint?: string;
}

export interface ProvenanceEntry extends DraftSectionEnvelope {
  heading: string;
  fingerprint: string;
}

export interface ParsedDraftSection {
  envelope: DraftSectionEnvelope;
  heading: string;
  /** Body under the `## heading` line, trimmed. */
  markdown: string;
  modifiedSinceReview: boolean;
}

export type DraftDocumentFormat = "v2" | "v1" | "none";

export interface DraftSectionParseResult {
  format: DraftDocumentFormat;
  sections: ParsedDraftSection[];
  issues: string[];
}

export interface ManagedSectionInput {
  envelope: DraftSectionEnvelope;
  heading: string;
  markdown: string;
}

export const PROVENANCE_LANGUAGE = "claude-provenance";
const PROVENANCE_FENCE = `\`\`\`${PROVENANCE_LANGUAGE}`;
const V1_MARKER = "<!-- cavi:draft-section";
const V1_START = /<!-- cavi:draft-section version=1 meta=([^\s]+) fingerprint=([a-z0-9-]+) -->\n/g;

interface Line { text: string; start: number; next: number }
interface Block { start: number; end: number; json: string }
interface LocatedSection extends ParsedDraftSection { bodyStart: number; bodyEnd: number }
interface V1Section extends ParsedDraftSection { start: number; end: number; acceptedFingerprint: string }

const validString = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const optionalString = (value: unknown): value is string | undefined => value === undefined || validString(value);
const isEvidenceRef = (value: unknown): value is { path: string; fingerprint: string } => isRecord(value) && validString(value.path) && validString(value.fingerprint);
const isCitation = (value: unknown): value is { key: string; sourcePath: string } => isRecord(value) && validString(value.key) && validString(value.sourcePath);


export function draftMarkdownFingerprint(markdown: string): string {
  return fnv1aFingerprint(markdown.trim());
}

export function containsReservedMarker(text: string): boolean {
  return text.includes(V1_MARKER) || text.includes(PROVENANCE_FENCE);
}

function envelopeFrom(value: unknown): DraftSectionEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const { id, provider, model, generatedAt, claimPaths, evidence, citations, claimFingerprint, revisionIntent, revisionInstruction, revisedFromFingerprint } = value;
  if (!validString(id) || !validString(provider) || !validString(model) || !validString(generatedAt)) return undefined;
  if (!optionalString(claimFingerprint) || !optionalString(revisionIntent) || !optionalString(revisionInstruction) || !optionalString(revisedFromFingerprint)) return undefined;
  if (!Array.isArray(claimPaths) || !claimPaths.every(validString)) return undefined;
  if (!Array.isArray(evidence) || !evidence.every(isEvidenceRef)) return undefined;
  if (!Array.isArray(citations) || !citations.every(isCitation)) return undefined;
  return {
    id,
    claimPaths: [...claimPaths],
    evidence: evidence.map(({ path, fingerprint }) => ({ path, fingerprint })),
    citations: citations.map(({ key, sourcePath }) => ({ key, sourcePath })),
    provider,
    model,
    generatedAt,
    ...(claimFingerprint ? { claimFingerprint } : {}),
    ...(revisionIntent ? { revisionIntent } : {}),
    ...(revisionInstruction ? { revisionInstruction } : {}),
    ...(revisedFromFingerprint ? { revisedFromFingerprint } : {}),
  };
}

function assertSafeEnvelope(envelope: DraftSectionEnvelope): void {
  if (!envelopeFrom(JSON.parse(JSON.stringify(envelope)))) throw new Error("Invalid draft section provenance envelope");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(envelope.id)) throw new Error(`Invalid draft section id: ${envelope.id}`);
}

export function sectionHeading(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Untitled section";
}

function mapOutsideFences(markdown: string, map: (line: string) => string): string {
  const rows = markdown.split("\n");
  const fenced = fencedLines(rows);
  return rows.map((line, i) => (fenced[i] ? line : map(line))).join("\n");
}

export function normalizeSectionBody(markdown: string): string {
  const body = mapOutsideFences(markdown.replace(/\r\n?/g, "\n").trim(), (line) => line.replace(/^##(?=\s)/, "###")).trim();
  if (containsReservedMarker(body)) throw new Error("Draft section Markdown contains a reserved Companion marker");
  return body;
}

export function cleanModelMarkdown(markdown: string): string {
  const rows = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  if (/^#{1,2}\s/.test(rows[0] ?? "")) rows.shift();
  return normalizeSectionBody(mapOutsideFences(rows.join("\n"), (line) => line.replace(/^#(?=\s)/, "###")));
}

function lines(text: string, limit = text.length): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < limit) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    out.push({ text: text.slice(start, end).replace(/\r$/, ""), start, next: newline < 0 ? text.length : newline + 1 });
    if (newline < 0) break;
    start = newline + 1;
  }
  return out;
}

function provenanceBlocks(text: string): Block[] {
  const all = lines(text);
  const blocks: Block[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const open = all[index]!;
    if (open.text.trimEnd() !== PROVENANCE_FENCE) continue;
    const close = all.findIndex((line, at) => at > index && line.text.trim() === "```");
    const closing = close < 0 ? undefined : all[close];
    blocks.push({
      start: open.start,
      end: closing ? closing.start + closing.text.length : text.length,
      json: all.slice(index + 1, close < 0 ? all.length : close).map(({ text: value }) => value).join("\n"),
    });
    if (close < 0) break;
    index = close;
  }
  return blocks;
}

function h2Headings(text: string, limit: number): Array<{ text: string; start: number; bodyStart: number }> {
  const out: Array<{ text: string; start: number; bodyStart: number }> = [];
  const all = lines(text, limit);
  const fenced = fencedLines(all.map((line) => line.text));
  for (const [index, line] of all.entries()) {
    if (fenced[index]) continue;
    const match = /^## (.*\S)\s*$/.exec(line.text);
    if (match) out.push({ text: sectionHeading(match[1]!), start: line.start, bodyStart: line.next });
  }
  return out;
}

function renderProvenanceBlock(entries: ProvenanceEntry[]): string {
  return `${PROVENANCE_FENCE}\n${JSON.stringify({ version: 2, sections: entries }, null, 2)}\n\`\`\``;
}

export function parseProvenanceJson(json: string): { entries: ProvenanceEntry[]; issues: string[] } {
  let data: unknown;
  try { data = JSON.parse(json); }
  catch (error) { return { entries: [], issues: [`Provenance block is unreadable: ${error instanceof Error ? error.message : String(error)}`] }; }
  if (!isRecord(data) || data.version !== 2 || !Array.isArray(data.sections)) return { entries: [], issues: ["Provenance block is unreadable: expected version 2 with a sections list"] };
  const entries: ProvenanceEntry[] = [];
  const issues: string[] = [];
  const ids = new Set<string>();
  data.sections.forEach((raw: unknown, index: number) => {
    const envelope = envelopeFrom(raw);
    if (!envelope || !isRecord(raw) || !validString(raw.heading) || !validString(raw.fingerprint)) { issues.push(`Provenance entry ${index + 1} is invalid`); return; }
    if (ids.has(envelope.id)) { issues.push(`Duplicate section id ${envelope.id}`); return; }
    ids.add(envelope.id);
    entries.push({ ...envelope, heading: sectionHeading(raw.heading), fingerprint: raw.fingerprint });
  });
  return { entries, issues };
}

function locateV2(text: string, block: Block): { sections: LocatedSection[]; issues: string[]; entries: ProvenanceEntry[] } {
  const { entries, issues } = parseProvenanceJson(block.json);
  const headings = h2Headings(text, block.start);
  const sections: LocatedSection[] = [];
  let cursor = -1;
  for (const entry of entries) {
    const bodyOf = (at: number): string => text.slice(headings[at]!.bodyStart, headings[at + 1]?.start ?? block.start).trim();
    const candidates = headings.flatMap((heading, at) => at > cursor && heading.text === entry.heading ? [at] : []);
    if (!candidates.length) { issues.push(`Section "${entry.heading}" not found — restore the heading or rebuild the outline`); continue; }
    const index = candidates.length === 1 ? candidates[0]! : candidates.find((at) => draftMarkdownFingerprint(bodyOf(at)) === entry.fingerprint) ?? -1;
    if (index < 0) { issues.push(`Duplicate heading "${entry.heading}" — rename one so the section can be found`); continue; }
    cursor = index;
    const heading = headings[index]!;
    const bodyEnd = headings[index + 1]?.start ?? block.start;
    const markdown = text.slice(heading.bodyStart, bodyEnd).trim();
    sections.push({ envelope: envelopeFrom(entry)!, heading: entry.heading, markdown, modifiedSinceReview: draftMarkdownFingerprint(markdown) !== entry.fingerprint, bodyStart: heading.bodyStart, bodyEnd });
  }
  return { sections, issues, entries };
}

function v1Heading(envelope: DraftSectionEnvelope): string {
  const claim = envelope.claimPaths[0] ?? envelope.id;
  return sectionHeading((claim.split("/").pop() ?? claim).replace(/\.md$/i, ""));
}

function locateV1(text: string): { sections: V1Section[]; issues: string[] } {
  const sections: V1Section[] = [];
  const issues: string[] = [];
  for (const match of text.matchAll(V1_START)) {
    let envelope: DraftSectionEnvelope | undefined;
    try { envelope = envelopeFrom(JSON.parse(decodeURIComponent(match[1] ?? ""))); } catch { envelope = undefined; }
    if (!envelope) { issues.push("Malformed draft section provenance envelope"); continue; }
    const contentStart = (match.index ?? 0) + match[0].length;
    const endMarker = `\n<!-- cavi:draft-section:end id=${envelope.id} -->`;
    const markerIndex = text.indexOf(endMarker, contentStart);
    if (markerIndex < 0) { issues.push(`Draft section ${envelope.id} is missing its closing marker`); continue; }
    const raw = text.slice(contentStart, markerIndex);
    const trimmed = raw.trim();
    const lead = /^##\s+(.+?)\s*$/.exec(trimmed.split("\n", 1)[0] ?? "");
    const acceptedFingerprint = match[2] ?? "";
    sections.push({
      envelope,
      heading: lead ? sectionHeading(lead[1]!) : v1Heading(envelope),
      markdown: normalizeSectionBody(lead ? trimmed.slice(trimmed.indexOf("\n") < 0 ? trimmed.length : trimmed.indexOf("\n") + 1) : raw),
      modifiedSinceReview: fnv1aFingerprint(raw) !== acceptedFingerprint,
      acceptedFingerprint,
      start: match.index ?? 0,
      end: markerIndex + endMarker.length,
    });
  }
  sections.forEach((section, at) => {
    const gap = text.slice(section.end, sections[at + 1]?.start ?? text.length).trim();
    if (gap && !/^## \S/.test(gap)) issues.push(`Text after "${section.heading}" is outside a managed section — put it under its own ## heading, then clean up again`);
  });
  return { sections, issues };
}

const publicSection = ({ envelope, heading, markdown, modifiedSinceReview }: ParsedDraftSection): ParsedDraftSection => ({ envelope, heading, markdown, modifiedSinceReview });

const toLf = (text: string): string => text.replace(/\r\n?/g, "\n");

export function parseDraftSections(source: string): DraftSectionParseResult {
  const document = toLf(source);
  const blocks = provenanceBlocks(document);
  const hasV1 = document.includes(V1_MARKER);
  if (blocks.length && hasV1) return { format: "v2", sections: [], issues: ["Document mixes old and new section markers"] };
  if (blocks.length > 1) return { format: "v2", sections: [], issues: ["Document has more than one provenance block"] };
  if (blocks[0]) {
    const located = locateV2(document, blocks[0]);
    return { format: "v2", sections: located.sections.map(publicSection), issues: located.issues };
  }
  if (hasV1) {
    const located = locateV1(document);
    return { format: "v1", sections: located.sections.map(publicSection), issues: located.issues };
  }
  return { format: "none", sections: [], issues: [] };
}

export function renderManagedDocument(preamble: string, sections: ManagedSectionInput[]): string {
  const entries: ProvenanceEntry[] = [];
  const ids = new Set<string>();
  const parts = sections.map(({ envelope, heading: rawHeading, markdown }) => {
    assertSafeEnvelope(envelope);
    if (ids.has(envelope.id)) throw new Error(`Duplicate section id ${envelope.id}`);
    ids.add(envelope.id);
    const heading = sectionHeading(rawHeading);
    const body = normalizeSectionBody(markdown);
    entries.push({ ...envelope, heading, fingerprint: draftMarkdownFingerprint(body) });
    return body ? `## ${heading}\n\n${body}` : `## ${heading}`;
  });
  validateDocumentCitationKeys(entries);
  return `${[preamble.trim(), ...parts, renderProvenanceBlock(entries)].filter(Boolean).join("\n\n")}\n`;
}

export function convertV1Document(source: string): { document: string; converted: number } {
  const document = toLf(source);
  if (!document.includes(V1_MARKER)) return { document, converted: 0 };
  if (provenanceBlocks(document).length) throw new Error("Document mixes old and new section markers");
  const { sections, issues } = locateV1(document);
  if (issues.length) throw new Error(`Research document has malformed managed sections: ${issues.join("; ")}`);
  if (!sections.length) return { document, converted: 0 };
  const entries: ProvenanceEntry[] = [];
  let out = "";
  let cursor = 0;
  for (const section of sections) {
    out += document.slice(cursor, section.start);
    out += section.markdown ? `## ${section.heading}\n\n${section.markdown}\n` : `## ${section.heading}\n`;
    cursor = section.end;
    entries.push({ ...section.envelope, heading: section.heading, fingerprint: section.modifiedSinceReview ? section.acceptedFingerprint : draftMarkdownFingerprint(section.markdown) });
  }
  out += document.slice(cursor);
  validateDocumentCitationKeys(entries);
  return { document: `${out.trimEnd()}\n\n${renderProvenanceBlock(entries)}\n`, converted: sections.length };
}

export function applyDraftSection(source: string, previewed: ParsedDraftSection, envelope: DraftSectionEnvelope, markdown: string): string {
  if (envelope.id !== previewed.envelope.id) throw new Error("Replacement draft section id must match the previewed section");
  assertSafeEnvelope(envelope);
  const body = normalizeSectionBody(markdown);
  if (!body) throw new Error("Draft section Markdown must not be empty");
  const document = toLf(source);
  const current = document.includes(V1_MARKER) ? convertV1Document(document).document : document;
  const blocks = provenanceBlocks(current);
  if (blocks.length !== 1) throw new Error("Research document has no managed sections");
  const block = blocks[0]!;
  const located = locateV2(current, block);
  if (located.issues.length) throw new Error(`Research document has malformed managed sections: ${located.issues.join("; ")}`);
  const target = located.sections.find(({ envelope: candidate }) => candidate.id === previewed.envelope.id);
  if (!target || target.heading !== previewed.heading || target.markdown !== previewed.markdown) throw new Error(`Draft section ${previewed.envelope.id} changed after the preview was generated`);
  const entries = located.entries.map((entry) => entry.id === envelope.id ? { ...envelope, heading: target.heading, fingerprint: draftMarkdownFingerprint(body) } : entry);
  validateDocumentCitationKeys(entries);
  const withBlock = `${current.slice(0, block.start)}${renderProvenanceBlock(entries)}${current.slice(block.end)}`;
  return `${withBlock.slice(0, target.bodyStart)}\n${body}\n\n${withBlock.slice(target.bodyEnd)}`;
}

export function validateDocumentCitationKeys(envelopes: DraftSectionEnvelope[]): void {
  const owners = new Map<string, string>();
  for (const envelope of envelopes) {
    for (const citation of envelope.citations) {
      const owner = owners.get(citation.key);
      if (owner && owner !== citation.sourcePath) throw new Error(`Citation key collision for ${citation.key}: ${owner} and ${citation.sourcePath}`);
      owners.set(citation.key, citation.sourcePath);
    }
  }
}

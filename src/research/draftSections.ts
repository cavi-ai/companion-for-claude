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

export interface ParsedDraftSection {
  envelope: DraftSectionEnvelope;
  markdown: string;
  modifiedSinceReview: boolean;
  start: number;
  end: number;
  raw: string;
}

export interface DraftSectionParseResult {
  sections: ParsedDraftSection[];
  issues: string[];
}

const START = /<!-- cavi:draft-section version=1 meta=([^\s]+) fingerprint=([a-z0-9-]+) -->\n/g;

function fingerprintText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function parseEnvelope(encoded: string): DraftSectionEnvelope | undefined {
  let value: unknown;
  try { value = JSON.parse(decodeURIComponent(encoded)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (![item.id, item.provider, item.model, item.generatedAt].every(validString)) return undefined;
  if (item.claimFingerprint !== undefined && !validString(item.claimFingerprint)) return undefined;
  if ([item.revisionIntent, item.revisionInstruction, item.revisedFromFingerprint].some((value) => value !== undefined && !validString(value))) return undefined;
  if (!Array.isArray(item.claimPaths) || !item.claimPaths.every(validString)) return undefined;
  if (!Array.isArray(item.evidence) || !item.evidence.every((entry) => entry && typeof entry === "object" && validString((entry as Record<string, unknown>).path) && validString((entry as Record<string, unknown>).fingerprint))) return undefined;
  if (!Array.isArray(item.citations) || !item.citations.every((entry) => entry && typeof entry === "object" && validString((entry as Record<string, unknown>).key) && validString((entry as Record<string, unknown>).sourcePath))) return undefined;
  return value as DraftSectionEnvelope;
}

export function draftMarkdownFingerprint(markdown: string): string { return fingerprintText(markdown); }

function assertSafeEnvelope(envelope: DraftSectionEnvelope): void {
  if (!parseEnvelope(encodeURIComponent(JSON.stringify(envelope)))) throw new Error("Invalid draft section provenance envelope");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(envelope.id)) throw new Error(`Invalid draft section id: ${envelope.id}`);
}

export function renderDraftSection(envelope: DraftSectionEnvelope, markdown: string): string {
  assertSafeEnvelope(envelope);
  const content = markdown.trim();
  if (!content) throw new Error("Draft section Markdown must not be empty");
  if (content.includes("<!-- cavi:draft-section")) throw new Error("Draft section Markdown contains a reserved Companion marker");
  const meta = encodeURIComponent(JSON.stringify(envelope));
  return `<!-- cavi:draft-section version=1 meta=${meta} fingerprint=${fingerprintText(content)} -->\n${content}\n<!-- cavi:draft-section:end id=${envelope.id} -->`;
}

export function parseDraftSections(document: string): DraftSectionParseResult {
  const sections: ParsedDraftSection[] = [];
  const issues: string[] = [];
  for (const match of document.matchAll(START)) {
    const encoded = match[1] ?? "";
    const acceptedFingerprint = match[2] ?? "";
    const envelope = parseEnvelope(encoded);
    if (!envelope) { issues.push("Malformed draft section provenance envelope"); continue; }
    const contentStart = (match.index ?? 0) + match[0].length;
    const endMarker = `\n<!-- cavi:draft-section:end id=${envelope.id} -->`;
    const markerIndex = document.indexOf(endMarker, contentStart);
    if (markerIndex < 0) { issues.push(`Draft section ${envelope.id} is missing its closing marker`); continue; }
    const end = markerIndex + endMarker.length;
    const markdown = document.slice(contentStart, markerIndex);
    sections.push({
      envelope,
      markdown,
      modifiedSinceReview: fingerprintText(markdown) !== acceptedFingerprint,
      start: match.index ?? 0,
      end,
      raw: document.slice(match.index ?? 0, end),
    });
  }
  return { sections, issues };
}

export function applyDraftSection(document: string, previewed: ParsedDraftSection, envelope: DraftSectionEnvelope, markdown: string): string {
  let start = previewed.start;
  if (document.slice(start, start + previewed.raw.length) !== previewed.raw) {
    start = document.indexOf(previewed.raw);
    if (start < 0 || document.indexOf(previewed.raw, start + 1) >= 0) throw new Error(`Draft section ${previewed.envelope.id} changed after the preview was generated`);
  }
  if (envelope.id !== previewed.envelope.id) throw new Error("Replacement draft section id must match the previewed section");
  return `${document.slice(0, start)}${renderDraftSection(envelope, markdown)}${document.slice(start + previewed.raw.length)}`;
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

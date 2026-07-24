import { buildProjectSnapshot, compareCodeUnits, type ProjectSnapshot } from "./graph";
import { canonicalSourceId, findDuplicate } from "./identity";
import { parseResearchCandidate, parseResearchRecord, type ResearchNoteInput } from "./parse";
import { renderResearchRecord } from "./render";
import { renderEvidenceOutline } from "./outline";
import { applyDraftSection, draftMarkdownFingerprint, parseDraftSections, validateDocumentCitationKeys, type DraftSectionEnvelope, type DraftSectionParseResult, type ParsedDraftSection } from "./draftSections";
import type { DraftGroundingPacket } from "./draftGrounding";
import { validateRevisionResponse, type RevisionRequest } from "./revisionPolicy";
import type {
  ClaimRecord,
  EvidenceRecord,
  ResearchDocumentRecord,
  ResearchProjectRecord,
  ResearchRecord,
  ResearchSourceRecord,
  ReviewState,
  SourceLocatorKind,
  EvidenceRelation,
  DiscoverySourceProvenance,
} from "./types";

export interface ResearchRepositoryIO {
  listMarkdown(): Promise<ResearchNoteInput[]>;
  listProjectMarkdown?(projectPath: string): Promise<ResearchNoteInput[]>;
  createWithParents(path: string, content: string): Promise<void>;
  updateFrontmatter(path: string, mutator: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  updateText?(path: string, updater: (content: string) => string): Promise<void>;
  readBinary?(path: string): Promise<Uint8Array>;
}

export interface CreateProjectInput {
  title: string;
  question: string;
  folder: string;
  audience?: string;
}

export interface ImportSourceInput {
  title: string;
  sourceKind: ResearchSourceRecord["sourceKind"];
  canonicalId?: string;
  url?: string;
  asset?: string;
  capturedContent?: string | Uint8Array;
  doi?: string;
  arxivId?: string;
  zoteroKey?: string;
  authors?: string[];
  published?: string;
  publication?: string;
  abstract?: string;
  openAccessUrl?: string;
  discoveryProvenance?: DiscoverySourceProvenance[];
}

export type ImportSourceResult = { kind: "created"; path: string } | { kind: "duplicate"; path: string };

export interface CreateEvidenceInput {
  project: string;
  source: string;
  title: string;
  excerpt: string;
  locatorKind?: SourceLocatorKind;
  locatorValue?: string;
  interpretation?: string;
  reviewState?: ReviewState;
  model?: string;
}

export interface CreateClaimInput {
  project: string;
  title: string;
  proposition: string;
  confidence?: ClaimRecord["confidence"];
  reviewState?: ReviewState;
  supports?: string[];
  challenges?: string[];
  contextualizes?: string[];
  limitations?: string[];
}

export interface AcceptDraftSectionInput {
  documentPath: string;
  preview: ParsedDraftSection;
  envelope: DraftSectionEnvelope;
  markdown: string;
  currentEvidence: Array<{ path: string; fingerprint: string }>;
  currentClaimFingerprint: string;
}
export interface AcceptRevisionSectionInput extends AcceptDraftSectionInput { packet: DraftGroundingPacket; request: RevisionRequest; response: unknown; }

const LAYOUT = {
  "research-source": "Sources",
  evidence: "Evidence",
  claim: "Claims",
  "research-question": "Questions",
  "research-document": "Documents",
} as const;

function safePath(path: string): string {
  if (!path || path.startsWith("/") || /[\\\0\r\n]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe research path: ${path}`);
  }
  return path;
}

function safeTitle(title: string): string {
  const value = title.trim();
  if (!value || value === "." || value === ".." || /[\\/\0\r\n]/.test(value)) throw new Error(`Unsafe research title: ${title}`);
  return value;
}

function projectFolder(projectPath: string): string {
  safePath(projectPath);
  if (!projectPath.endsWith("/Project.md")) throw new Error(`Project path must end with /Project.md: ${projectPath}`);
  return projectPath.slice(0, -"/Project.md".length);
}

function recordPath(project: string, type: keyof typeof LAYOUT, title: string): string {
  return `${projectFolder(project)}/${LAYOUT[type]}/${safeTitle(title)}.md`;
}

function parentFolder(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

async function contentFingerprint(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export class ResearchRepository {
  constructor(private readonly io: ResearchRepositoryIO) {}

  async listProjects(): Promise<ResearchProjectRecord[]> {
    const projects: ResearchProjectRecord[] = [];
    for (const note of await this.io.listMarkdown()) {
      const parsed = parseResearchRecord(note).record;
      if (parsed?.type === "research-project") projects.push(parsed);
    }
    return projects.sort((left, right) => compareCodeUnits(left.title, right.title) || compareCodeUnits(left.path, right.path));
  }

  async loadProject(projectPath: string): Promise<ProjectSnapshot> {
    projectFolder(projectPath);
    let scoped = false;
    let notes: ResearchNoteInput[];
    if (this.io.listProjectMarkdown) {
      scoped = true;
      notes = await this.io.listProjectMarkdown(projectPath);
    } else {
      notes = await this.io.listMarkdown();
    }
    const parsed = notes.map(scoped ? parseResearchCandidate : parseResearchRecord);
    const records = await Promise.all(parsed.flatMap(({ record }) => record ? [record] : []).map(async (record) => {
      if (record.type !== "research-source") return record;
      let currentPayload: string | Uint8Array | undefined = record.capturedContent;
      if (currentPayload === undefined && record.asset && this.io.readBinary) {
        try { currentPayload = await this.io.readBinary(record.asset); } catch { currentPayload = undefined; }
      }
      const { contentFingerprint: _storedFingerprint, ...withoutStoredFingerprint } = record;
      return currentPayload === undefined
        ? withoutStoredFingerprint
        : { ...withoutStoredFingerprint, contentFingerprint: await contentFingerprint(currentPayload) };
    }));
    return buildProjectSnapshot(projectPath, records, parsed.flatMap(({ issues }) => issues));
  }

  async createProject(input: CreateProjectInput): Promise<ResearchProjectRecord> {
    const folder = safePath(input.folder.replace(/\/$/, ""));
    const path = `${folder}/Project.md`;
    const record: ResearchProjectRecord = {
      path,
      title: safeTitle(input.title),
      type: "research-project",
      project: path,
      question: input.question.trim(),
      ...(input.audience?.trim() ? { audience: input.audience.trim() } : {}),
      stage: "frame",
      status: "active",
    };
    if (!record.question) throw new Error("Research question must not be empty");
    await this.createRecord(record);
    return record;
  }

  async importSource(projectPath: string, input: ImportSourceInput): Promise<ImportSourceResult> {
    const authors = input.authors ? [...input.authors] : undefined;
    const provenance = input.discoveryProvenance?.map(({ adapter, externalId }) => ({ adapter, externalId }));
    const project = await this.loadProject(projectPath);
    if (input.asset) safePath(input.asset);
    if (input.capturedContent instanceof Uint8Array && !input.asset) throw new Error("Binary source capture requires an asset path");
    if (input.openAccessUrl) {
      let protocol: string;
      try { protocol = new URL(input.openAccessUrl).protocol; } catch { throw new Error("Open access URL must be a valid http: or https: URL"); }
      if (protocol !== "http:" && protocol !== "https:") throw new Error("Open access URL must use http: or https:");
    }
    const capturedPayload = input.capturedContent instanceof Uint8Array && input.asset && this.io.readBinary
      ? await this.io.readBinary(input.asset)
      : input.capturedContent;
    const fingerprint = capturedPayload === undefined ? undefined : await contentFingerprint(capturedPayload);
    const candidate: ResearchSourceRecord = {
      path: recordPath(projectPath, "research-source", input.title),
      title: safeTitle(input.title),
      type: "research-source",
      project: project.project.path,
      sourceKind: input.sourceKind,
      ...(input.canonicalId ? { canonicalId: input.canonicalId } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.asset ? { asset: input.asset } : {}),
      ...(typeof input.capturedContent === "string" ? { capturedContent: input.capturedContent } : {}),
      ...(fingerprint ? { contentFingerprint: fingerprint } : {}),
      ...(input.doi ? { doi: input.doi } : {}),
      ...(input.arxivId ? { arxivId: input.arxivId } : {}),
      ...(input.zoteroKey ? { zoteroKey: input.zoteroKey } : {}),
      ...(authors?.length ? { authors } : {}),
      ...(input.published ? { published: input.published } : {}),
      ...(input.publication ? { publication: input.publication } : {}),
      ...(input.abstract !== undefined ? { abstract: input.abstract.slice(0, 20_000) } : {}),
      ...(input.openAccessUrl ? { openAccessUrl: input.openAccessUrl } : {}),
      ...(provenance?.length ? { discoveryProvenance: provenance } : {}),
    };
    const canonicalId = canonicalSourceId(candidate);
    if (canonicalId) candidate.canonicalId = canonicalId;
    const duplicate = findDuplicate(candidate, project.sources);
    if (duplicate) return { kind: "duplicate", path: duplicate.path };
    await this.createRecord(candidate);
    return { kind: "created", path: candidate.path };
  }

  async createEvidence(input: CreateEvidenceInput): Promise<EvidenceRecord> {
    const snapshot = await this.loadProject(input.project);
    const source = snapshot.sources.find((candidate) => candidate.path === input.source);
    if (!source) throw new Error(`Source is not part of project: ${input.source}`);
    if (!input.excerpt.trim()) throw new Error("Evidence excerpt must not be empty");
    return this.createTyped({
      path: recordPath(input.project, "evidence", input.title), title: safeTitle(input.title), type: "evidence",
      project: input.project, source: source.path,
      ...(source.contentFingerprint ? { sourceFingerprint: source.contentFingerprint } : {}),
      excerpt: input.excerpt, ...(input.locatorKind ? { locatorKind: input.locatorKind } : {}),
      ...(input.locatorValue ? { locatorValue: input.locatorValue } : {}),
      ...(input.interpretation ? { interpretation: input.interpretation } : {}),
      reviewState: input.reviewState ?? "proposed", ...(input.model ? { model: input.model } : {}),
    });
  }

  async createClaim(input: CreateClaimInput): Promise<ClaimRecord> {
    if (!input.proposition.trim()) throw new Error("Claim proposition must not be empty");
    const snapshot = await this.loadProject(input.project);
    const evidencePaths = new Set(snapshot.evidence.map(({ path }) => path));
    for (const path of [...(input.supports ?? []), ...(input.challenges ?? []), ...(input.contextualizes ?? [])]) {
      if (!evidencePaths.has(path)) throw new Error(`Evidence is not part of project: ${path}`);
    }
    return this.createTyped({
      path: recordPath(input.project, "claim", input.title), title: safeTitle(input.title), type: "claim", project: input.project,
      proposition: input.proposition, confidence: input.confidence ?? "moderate", reviewState: input.reviewState ?? "proposed",
      supports: [...(input.supports ?? [])], challenges: [...(input.challenges ?? [])], contextualizes: [...(input.contextualizes ?? [])], limitations: [...(input.limitations ?? [])],
    });
  }

  async linkClaimEvidence(projectPath: string, claimPath: string, evidencePath: string, relation: EvidenceRelation): Promise<void> {
    const snapshot = await this.loadProject(projectPath);
    const claim = snapshot.claims.find((candidate) => candidate.path === claimPath);
    if (!claim) throw new Error(`Claim is not part of project: ${claimPath}`);
    if (!snapshot.evidence.some((candidate) => candidate.path === evidencePath)) throw new Error(`Evidence is not part of project: ${evidencePath}`);
    if (!["supports", "challenges", "contextualizes"].includes(relation)) throw new Error(`Unsupported evidence relation: ${relation}`);
    await this.io.updateFrontmatter(claim.path, (frontmatter) => {
      const current = Array.isArray(frontmatter[relation]) ? (frontmatter[relation] as unknown[]).filter((value): value is string => typeof value === "string") : [];
      frontmatter[relation] = [...new Set([...current, `[[${evidencePath}]]`])];
    });
  }

  async createOutline(projectPath: string, claimPaths: string[]): Promise<{ path: string; content: string }> {
    const snapshot = await this.loadProject(projectPath);
    const claims = claimPaths.map((path) => {
      const claim = snapshot.claims.find((candidate) => candidate.path === path);
      if (!claim) throw new Error(`Claim is not part of project: ${path}`);
      return claim;
    });
    const record: ResearchDocumentRecord = { path: `${projectFolder(projectPath)}/Documents/Outline.md`, title: "Outline", type: "research-document", project: projectPath, documentKind: "outline", claims: claims.map(({ path }) => path) };
    const content = renderEvidenceOutline(snapshot, claims.map(({ path }) => path));
    safePath(record.path);
    try {
      await this.io.createWithParents(record.path, content);
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) throw new Error(`Research record already exists: ${record.path}`);
      throw error;
    }
    return { path: record.path, content };
  }

  async acceptDraftSection(input: AcceptDraftSectionInput): Promise<void> {
    safePath(input.documentPath);
    if (!/\/Documents\/[^/]+\.md$/.test(input.documentPath)) throw new Error(`Research document is outside canonical layout: ${input.documentPath}`);
    if (!this.io.updateText) throw new Error("Atomic research document updates are unavailable");
    if (JSON.stringify(input.envelope.claimPaths) !== JSON.stringify(input.preview.envelope.claimPaths)) throw new Error("Replacement draft section claims must match the previewed section");
    if (JSON.stringify(input.currentEvidence) !== JSON.stringify(input.envelope.evidence)) throw new Error("Draft evidence changed after the preview was generated");
    if (!input.envelope.claimFingerprint || input.currentClaimFingerprint !== input.envelope.claimFingerprint) throw new Error("Draft claim changed after the preview was generated");
    await this.io.updateText(input.documentPath, (current) => {
      const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(current);
      if (!frontmatter || !/^type:\s*["']?research-document["']?\s*$/m.test(frontmatter[1] ?? "")) throw new Error(`Research record is not a document: ${input.documentPath}`);
      const parsedSections = parseDraftSections(current);
      if (parsedSections.issues.length) throw new Error(`Research document has malformed managed sections: ${parsedSections.issues.join("; ")}`);
      validateDocumentCitationKeys([...parsedSections.sections.filter(({ envelope }) => envelope.id !== input.envelope.id).map(({ envelope }) => envelope), input.envelope]);
      let updated = applyDraftSection(current, input.preview, input.envelope, input.markdown);
      if (/^document_kind:\s*["']?outline["']?\s*$/m.test(frontmatter[1] ?? "")) updated = updated.replace(/^document_kind:\s*["']?outline["']?\s*$/m, "document_kind: draft");
      else if (!/^document_kind:\s*["']?draft["']?\s*$/m.test(frontmatter[1] ?? "")) throw new Error(`Research document kind is invalid: ${input.documentPath}`);
      return updated;
    });
  }

  async acceptRevisionSection(input: AcceptRevisionSectionInput): Promise<void> {
    const validated = validateRevisionResponse(input.packet, input.request, input.response, input.preview.markdown);
    if (!validated.canAccept || validated.markdown !== input.markdown) throw new Error("Blocked or mismatched revision cannot be accepted");
    if (!input.envelope.revisionIntent || !input.envelope.revisedFromFingerprint) throw new Error("Revision provenance is incomplete");
    if (input.envelope.revisedFromFingerprint !== draftMarkdownFingerprint(input.preview.markdown)) throw new Error("Revision source changed after the preview was generated");
    await this.acceptDraftSection(input);
  }

  async loadDraftSections(documentPath: string): Promise<DraftSectionParseResult> {
    safePath(documentPath);
    if (!/\/Documents\/[^/]+\.md$/.test(documentPath)) throw new Error(`Research document is outside canonical layout: ${documentPath}`);
    const note = (await this.io.listMarkdown()).find(({ path }) => path === documentPath);
    if (!note) throw new Error(`Research document not found: ${documentPath}`);
    const parsed = parseResearchRecord(note);
    if (!parsed.record || parsed.record.type !== "research-document") throw new Error(`Research record is not a document: ${documentPath}`);
    return parseDraftSections(note.body);
  }

  private async createRecord(record: ResearchRecord): Promise<void> {
    safePath(record.path);
    const folder = projectFolder(record.type === "research-project" ? record.path : record.project);
    const expectedParent = record.type === "research-project" ? folder : `${folder}/${LAYOUT[record.type]}`;
    if (parentFolder(record.path) !== expectedParent) throw new Error(`Research record is outside canonical layout: ${record.path}`);
    if (record.type === "research-project" && record.project !== record.path) throw new Error(`Research project must link to itself: ${record.path}`);
    try {
      await this.io.createWithParents(record.path, renderResearchRecord(record));
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) throw new Error(`Research record already exists: ${record.path}`);
      throw error;
    }
  }

  async reviewEvidence(path: string, state: "reviewed" | "rejected"): Promise<EvidenceRecord> {
    safePath(path);
    if (state !== "reviewed" && state !== "rejected") throw new Error(`Unsupported evidence review target: ${String(state)}`);
    const note = (await this.io.listMarkdown()).find((candidate) => candidate.path === path);
    if (!note) throw new Error(`Research evidence not found: ${path}`);
    const result = parseResearchRecord(note);
    if (!result.record || result.record.type !== "evidence") throw new Error(`Research record is not evidence: ${path}`);
    await this.io.updateFrontmatter(path, (frontmatter) => { frontmatter.review_state = state; });
    return { ...result.record, reviewState: state };
  }

  private async createTyped<T extends ResearchRecord>(record: T): Promise<T> {
    await this.loadProject(record.project);
    await this.createRecord(record);
    return record;
  }
}

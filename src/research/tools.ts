import type { McpToolDef } from "../mcp/protocol";
import { auditProject } from "./audit";
import type { ResearchRepository } from "./repository";
import { isReviewState, type EvidenceRelation, type SourceLocatorKind } from "./types";
import type { WebCapture } from "./webCapture";

export const RESEARCH_WRITE_TOOLS = new Set([
  "research_project_create", "research_source_import",
  "research_evidence_capture", "research_evidence_review",
  "research_claim_create", "research_claim_link", "research_outline_generate",
  "research_evidence_create", "research_outline_create",
]);

/** Legacy call names accepted by MCP dispatch but intentionally omitted from discovery. */
export const HIDDEN_RESEARCH_TOOL_ALIASES: ReadonlySet<string> = new Set([
  "research_evidence_create",
  "research_outline_create",
]);

type Repository = Pick<ResearchRepository, "loadProject" | "createProject" | "importSource" | "createEvidence" | "reviewEvidence" | "createClaim" | "linkClaimEvidence" | "createOutline">;

const object = (properties: Record<string, unknown>, required: string[]): McpToolDef["inputSchema"] => ({ type: "object", properties, required });
const text = (description: string) => ({ type: "string", description });

export class ResearchTools {
  constructor(private readonly repository: Repository, private readonly captureWeb?: WebCapture) {}

  definitions(): McpToolDef[] {
    const project = { project: text("Vault path to the research Project.md note.") };
    return [
      { name: "research_project_create", description: "Create a canonical vault-native research project after user confirmation.", inputSchema: object({ title: text("Project title."), question: text("Research question."), folder: text("Vault-relative project folder."), audience: text("Optional audience.") }, ["title", "question", "folder"]) },
      { name: "research_source_import", description: "Import a canonical text capture or metadata-only source into a research project. Web sources with a url and no captured_text are fetched and reduced to clean readable markdown automatically. Binary sources require an existing vault asset and an adapter-supported path.", inputSchema: object({ ...project, title: text("Source title."), source_kind: text("pdf, web, doi, arxiv, zotero, or vault."), canonical_id: text("Optional stable identifier."), url: text("Optional source URL."), asset: text("Optional existing vault asset path."), captured_text: text("Optional canonical captured text (omit for web sources to auto-capture the page)."), doi: text("Optional DOI."), arxiv_id: text("Optional arXiv id."), zotero_key: text("Optional Zotero key."), authors: { type: "array", items: { type: "string" } }, published: text("Optional publication date."), publication: text("Optional publication title.") }, ["project", "title", "source_kind"]) },
      { name: "research_project_read", description: "Read a compact research project snapshot with sources, evidence, claims, issues, and health.", inputSchema: object(project, ["project"]) },
      { name: "research_evidence_capture", description: "Create a provenance-linked evidence card inside a research project.", inputSchema: object({ ...project, source: text("Source record path in this project."), title: text("Evidence title."), excerpt: text("Exact source excerpt."), locator_kind: text("page, section, paragraph, timestamp, or quote."), locator_value: text("Exact locator text."), interpretation: text("Optional interpretation."), review_state: text("proposed, reviewed, or rejected.") }, ["project", "source", "title", "excerpt"]) },
      { name: "research_evidence_review", description: "Mark an evidence card as reviewed or rejected.", inputSchema: object({ evidence: text("Evidence record path."), review_state: text("reviewed or rejected.") }, ["evidence", "review_state"]) },
      { name: "research_claim_create", description: "Create a claim with separate supporting, challenging, and contextual evidence relations.", inputSchema: object({ ...project, title: text("Claim title."), proposition: text("Claim proposition."), confidence: text("low, moderate, or high."), review_state: text("proposed, reviewed, or rejected."), supports: { type: "array", items: { type: "string" } }, challenges: { type: "array", items: { type: "string" } }, contextualizes: { type: "array", items: { type: "string" } }, limitations: { type: "array", items: { type: "string" } } }, ["project", "title", "proposition"]) },
      { name: "research_claim_link", description: "Link evidence to a claim as supporting, challenging, or contextualizing.", inputSchema: object({ ...project, claim: text("Claim path."), evidence: text("Evidence path."), relation: text("supports, challenges, or contextualizes.") }, ["project", "claim", "evidence", "relation"]) },
      { name: "research_audit", description: "Audit a research project and return actionable JSON findings.", inputSchema: object(project, ["project"]) },
      { name: "research_outline_generate", description: "Create an evidence-backed outline preserving supporting, challenging, and contextual evidence provenance.", inputSchema: object({ ...project, claims: { type: "array", items: { type: "string" } } }, ["project", "claims"]) },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "research_project_create": {
        const audience = optionalString(args.audience);
        const record = await this.repository.createProject({ title: requiredString(args.title), question: requiredString(args.question), folder: requiredString(args.folder), ...(audience ? { audience } : {}) });
        return JSON.stringify({ path: record.path });
      }
      case "research_source_import": {
        const sourceKind = requiredString(args.source_kind);
        if (!["pdf", "web", "doi", "arxiv", "zotero", "vault"].includes(sourceKind)) throw new Error(`Unsupported source kind: ${sourceKind}`);
        let capturedContent = optionalString(args.captured_text);
        let authors = stringArray(args.authors, "authors");
        let published = optionalString(args.published);
        const url = optionalString(args.url);
        // Auto-capture web sources: fetch + readable-markdown extraction, so
        // the note holds trustworthy fingerprinted text, not just a link.
        let autoCapture: boolean | undefined;
        if (sourceKind === "web" && url && !capturedContent && this.captureWeb) {
          autoCapture = false;
          try {
            const captured = await this.captureWeb(url);
            if (captured) {
              capturedContent = captured.markdown;
              autoCapture = true;
              if (!authors.length && captured.author) authors = [captured.author];
              if (!published && captured.published) published = captured.published;
            }
          } catch {
            // Metadata-only import still succeeds; the caller sees captured: false.
          }
        }
        const result = await this.repository.importSource(requiredString(args.project), {
          title: requiredString(args.title), sourceKind: sourceKind as "pdf" | "web" | "doi" | "arxiv" | "zotero" | "vault",
          ...optionalField("canonicalId", args.canonical_id), ...(url ? { url } : {}), ...optionalField("asset", args.asset),
          ...(capturedContent ? { capturedContent } : {}), ...optionalField("doi", args.doi), ...optionalField("arxivId", args.arxiv_id),
          ...optionalField("zoteroKey", args.zotero_key), ...(authors.length ? { authors } : {}),
          ...(published ? { published } : {}), ...optionalField("publication", args.publication),
        });
        return JSON.stringify(autoCapture === undefined ? result : { ...result, captured: autoCapture });
      }
      case "research_project_read": {
        const project = requiredString(args.project);
        const snapshot = await this.repository.loadProject(project);
        return JSON.stringify({
          project: { path: compactString(snapshot.project.path), title: compactString(snapshot.project.title), question: compactString(snapshot.project.question, 500), stage: snapshot.project.stage, status: snapshot.project.status },
          health: snapshot.health,
          counts: { sources: snapshot.sources.length, evidence: snapshot.evidence.length, claims: snapshot.claims.length, questions: snapshot.questions.length, documents: snapshot.documents.length, issues: snapshot.issues.length },
          paths: {
            sources: pathSummary(snapshot.sources), evidence: pathSummary(snapshot.evidence), claims: pathSummary(snapshot.claims),
            questions: pathSummary(snapshot.questions), documents: pathSummary(snapshot.documents), issues: pathSummary(snapshot.issues),
          },
        });
      }
      case "research_audit": return JSON.stringify(auditProject(await this.repository.loadProject(requiredString(args.project))).map((finding) => ({ rule: finding.code, ...finding })));
      case "research_evidence_capture":
      case "research_evidence_create": {
        const project = requiredString(args.project);
        if (typeof args.excerpt !== "string" || !args.excerpt.trim()) throw new Error("Evidence excerpt must not be empty");
        const excerpt = args.excerpt;
        const reviewState = args.review_state === undefined ? "proposed" : requiredString(args.review_state);
        if (!isReviewState(reviewState)) throw new Error(`Unsupported review state: ${reviewState}`);
        const locatorKindValue = optionalString(args.locator_kind);
        if (locatorKindValue && !["page", "section", "paragraph", "timestamp", "quote"].includes(locatorKindValue)) throw new Error(`Unsupported locator kind: ${locatorKindValue}`);
        const locatorKind = locatorKindValue as SourceLocatorKind | undefined;
        const locatorValue = optionalString(args.locator_value);
        const interpretation = optionalString(args.interpretation);
        if (reviewState === "reviewed" && (!locatorKind || !locatorValue?.trim())) throw new Error("Reviewed evidence requires an exact locator kind and value");
        const record = await this.repository.createEvidence({ project, source: requiredString(args.source), title: requiredString(args.title), excerpt, reviewState, ...(locatorKind ? { locatorKind } : {}), ...(locatorValue ? { locatorValue } : {}), ...(interpretation ? { interpretation } : {}) });
        return JSON.stringify({ path: record.path });
      }
      case "research_evidence_review": {
        const state = requiredString(args.review_state);
        if (state !== "reviewed" && state !== "rejected") throw new Error(`Unsupported evidence review state: ${state}`);
        const record = await this.repository.reviewEvidence(requiredString(args.evidence), state);
        return JSON.stringify({ path: record.path, review_state: record.reviewState });
      }
      case "research_claim_create": {
        const project = requiredString(args.project);
        const reviewState = args.review_state === undefined ? "proposed" : requiredString(args.review_state);
        if (!isReviewState(reviewState)) throw new Error(`Unsupported review state: ${reviewState}`);
        const confidence = optionalString(args.confidence) ?? "moderate";
        if (!["low", "moderate", "high"].includes(confidence)) throw new Error(`Unsupported confidence: ${confidence}`);
        const record = await this.repository.createClaim({ project, title: requiredString(args.title), proposition: requiredString(args.proposition), reviewState, confidence: confidence as "low" | "moderate" | "high", supports: stringArray(args.supports, "supports"), challenges: stringArray(args.challenges, "challenges"), contextualizes: stringArray(args.contextualizes, "contextualizes"), limitations: stringArray(args.limitations, "limitations") });
        return JSON.stringify({ path: record.path });
      }
      case "research_claim_link": {
        const project = requiredString(args.project);
        const relation = requiredString(args.relation) as EvidenceRelation;
        if (!["supports", "challenges", "contextualizes"].includes(relation)) throw new Error(`Unsupported evidence relation: ${relation}`);
        await this.repository.linkClaimEvidence(project, requiredString(args.claim), requiredString(args.evidence), relation);
        return JSON.stringify({ linked: true });
      }
      case "research_outline_generate":
      case "research_outline_create": return JSON.stringify(await this.repository.createOutline(requiredString(args.project), stringArray(args.claims, "claims", true)));
      default: throw new Error(`Unknown research tool: ${name}`);
    }
  }
}

function requiredString(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("Expected a non-empty string argument"); return value; }
function optionalString(value: unknown): string | undefined { if (value === undefined) return undefined; return requiredString(value); }
function optionalField<K extends string>(key: K, value: unknown): Partial<Record<K, string>> { const parsed = optionalString(value); return parsed ? { [key]: parsed } as Record<K, string> : {}; }
function stringArray(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be an array of non-empty strings`);
  return value.map((item) => String(item));
}
function pathSummary(records: readonly { path: string }[]): { items: string[]; omitted: number } {
  const items = records.slice(0, 8).map(({ path }) => compactString(path));
  return { items, omitted: records.length - items.length };
}
function compactString(value: string, max = 120): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }

import type { ProjectSnapshot } from "./graph";
import type { EvidenceRecord, EvidenceRelation } from "./types";

export interface ClaimSuggestion {
  title: string;
  proposition: string;
  confidence: "low" | "moderate" | "high";
  relations: Record<string, EvidenceRelation>;
}

const RELATIONS: readonly EvidenceRelation[] = ["supports", "challenges", "contextualizes"];
const MAX_TITLE = 80;

export function claimSuggestionEvidence(snapshot: ProjectSnapshot): EvidenceRecord[] {
  const reviewed = snapshot.evidence.filter(({ reviewState }) => reviewState === "reviewed");
  const linked = new Set(snapshot.claims.flatMap(({ supports, challenges, contextualizes }) => [...supports, ...challenges, ...contextualizes]));
  const unlinked = reviewed.filter(({ path }) => !linked.has(path));
  return unlinked.length ? unlinked : reviewed;
}

export function buildClaimSuggestionRequest(question: string, evidence: Array<{ path: string; title: string; excerpt: string; interpretation?: string }>): { system: string; user: string } {
  const system = [
    "You propose one research claim from checked passages.",
    "Reply with JSON only, no prose: {\"title\":\"...\",\"proposition\":\"...\",\"confidence\":\"low|moderate|high\",\"relations\":[{\"evidence\":\"<path>\",\"relation\":\"supports|challenges|contextualizes\"}]}.",
    "The title is a short label. The proposition is one precise sentence, hedged to what the passages show and nothing beyond them.",
    "List every passage given in relations, using its path exactly.",
  ].join("\n");
  const items = evidence.map((item) => `- path: ${item.path}\n  title: ${item.title}\n  passage: ${item.excerpt}${item.interpretation ? `\n  reading: ${item.interpretation}` : ""}`).join("\n");
  return { system, user: `Research question: ${question}\n\nPassages:\n${items}` };
}

function trimTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, " ");
  if (title.length <= MAX_TITLE) return title;
  const cut = title.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start < 0) return undefined;
  for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* try a shorter slice */ }
  }
  return undefined;
}

export function parseClaimSuggestion(raw: string, offered: ReadonlySet<string>): ClaimSuggestion | null {
  const parsed = firstJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  const title = typeof data.title === "string" ? trimTitle(data.title) : "";
  const proposition = typeof data.proposition === "string" ? data.proposition.trim() : "";
  if (!title || !proposition) return null;
  const confidence = data.confidence === "low" || data.confidence === "high" ? data.confidence : "moderate";
  const relations: Record<string, EvidenceRelation> = {};
  if (Array.isArray(data.relations)) {
    for (const item of data.relations) {
      if (!item || typeof item !== "object") continue;
      const { evidence, relation } = item as Record<string, unknown>;
      if (typeof evidence === "string" && offered.has(evidence) && RELATIONS.includes(relation as EvidenceRelation)) relations[evidence] = relation as EvidenceRelation;
    }
  }
  return { title, proposition, confidence, relations };
}

import type { ResearchRepository } from "../research/repository";
import type { ResearchRecord, SourceLocatorKind } from "../research/types";

/** Reserved research keys the generic frontmatter writers route through the research repository. */
export const DELEGABLE_RESEARCH_KEYS: ReadonlySet<string> = new Set(["review_state", "locator_kind", "locator_value"]);

export const RESEARCH_ROUTE_HINT = "Use the research_* tools (research_evidence_review, research_evidence_locate, research_claim_review, research_claim_link) to change research records.";

const LOCATOR_KINDS: readonly string[] = ["page", "section", "paragraph", "timestamp", "quote"];

type Step =
  | { kind: "locator"; locatorKind: SourceLocatorKind; value: string }
  | { kind: "review-evidence"; state: "reviewed" | "rejected" }
  | { kind: "review-claim"; state: "proposed" | "reviewed" | "rejected" };

export interface ResearchRoutePlan {
  path: string;
  steps: Step[];
  summaries: string[];
}

/** Validate delegable key changes against a research record; throws a model-readable refusal. */
export function planResearchRouting(record: ResearchRecord | undefined, changes: Record<string, unknown>): ResearchRoutePlan {
  const keys = Object.keys(changes);
  if (!record || (record.type !== "evidence" && record.type !== "claim")) {
    throw new Error(`Frontmatter key "${keys[0] ?? ""}" is managed by Companion. ${RESEARCH_ROUTE_HINT}`);
  }
  const plan: ResearchRoutePlan = { path: record.path, steps: [], summaries: [] };
  const hasLocator = "locator_kind" in changes || "locator_value" in changes;
  if (hasLocator) {
    if (record.type !== "evidence") throw new Error(`Claims have no locator. ${RESEARCH_ROUTE_HINT}`);
    const kind = "locator_kind" in changes ? changes.locator_kind : record.locatorKind;
    const rawValue = "locator_value" in changes ? changes.locator_value : record.locatorValue;
    if (typeof kind !== "string" || !LOCATOR_KINDS.includes(kind)) throw new Error(`locator_kind must be one of: ${LOCATOR_KINDS.join(", ")}. Set locator_kind and locator_value together.`);
    const value = typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue).trim() : "";
    if (!value) throw new Error("locator_value must be a non-empty value. Set locator_kind and locator_value together.");
    plan.steps.push({ kind: "locator", locatorKind: kind as SourceLocatorKind, value });
    plan.summaries.push(`Set the locator of "${record.title}" to ${kind} ${value}.`);
  }
  if ("review_state" in changes) {
    const state = changes.review_state;
    if (record.type === "evidence") {
      if (state !== "reviewed" && state !== "rejected") throw new Error("review_state on evidence must be one of: reviewed, rejected.");
      plan.steps.push({ kind: "review-evidence", state });
      plan.summaries.push(state === "reviewed" ? `Marked "${record.title}" reviewed and re-checked it against the current source.` : `Marked "${record.title}" rejected.`);
    } else {
      if (state !== "proposed" && state !== "reviewed" && state !== "rejected") throw new Error("review_state on a claim must be one of: proposed, reviewed, rejected.");
      plan.steps.push({ kind: "review-claim", state });
      plan.summaries.push(`Marked claim "${record.title}" ${state}.`);
    }
  }
  return plan;
}

export async function runResearchRouting(repository: Pick<ResearchRepository, "reviewEvidence" | "updateEvidenceLocator" | "reviewClaim">, plan: ResearchRoutePlan): Promise<void> {
  for (const step of plan.steps) {
    if (step.kind === "locator") await repository.updateEvidenceLocator(plan.path, step.locatorKind, step.value);
    else if (step.kind === "review-evidence") await repository.reviewEvidence(plan.path, step.state);
    else await repository.reviewClaim(plan.path, step.state);
  }
}

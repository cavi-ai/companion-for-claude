import { auditProject, type AuditFinding } from "./audit";
import { compareCodeUnits, isTrustedEvidence, type ProjectSnapshot } from "./graph";

export type IntelligenceCategory = "contradiction" | "method-difference" | "research-gap" | "evidence-quality";
export type EpistemicLabel = "observation" | "inference" | "suggested-investigation";

export interface IntelligenceFinding {
  id: string;
  category: IntelligenceCategory;
  severity: "error" | "warning" | "info";
  confidence: "high" | "medium" | "low";
  epistemicStatus: EpistemicLabel;
  title: string;
  rationale: string;
  paths: string[];
  verification: string;
}

const severityOrder: Record<IntelligenceFinding["severity"], number> = { error: 0, warning: 1, info: 2 };

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort(compareCodeUnits);
}

function findingId(category: IntelligenceCategory, rule: string, paths: string[]): string {
  return `${category}:${rule}:${uniquePaths(paths).join("|")}`;
}

function stableFindings(findings: IntelligenceFinding[]): IntelligenceFinding[] {
  const unique = new Map<string, IntelligenceFinding>();
  for (const finding of findings) unique.set(finding.id, finding);
  return [...unique.values()].sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity]
    || compareCodeUnits(left.category, right.category)
    || compareCodeUnits(left.paths[0] ?? "", right.paths[0] ?? "")
    || compareCodeUnits(left.id, right.id));
}

function auditCategory(audit: AuditFinding, snapshot: ProjectSnapshot): IntelligenceCategory {
  if (audit.code === "unsupported-claim") return "research-gap";
  if (audit.code === "unused-evidence" && snapshot.evidence.some(({ path, reviewState }) => path === audit.path && reviewState === "reviewed")) return "research-gap";
  return "evidence-quality";
}

export function analyzeProjectIntelligence(snapshot: ProjectSnapshot): IntelligenceFinding[] {
  const findings: IntelligenceFinding[] = [];
  const sources = new Map(snapshot.sources.map((source) => [source.path, source]));
  const evidence = new Map(snapshot.evidence.map((item) => [item.path, item]));

  for (const question of snapshot.questions) {
    if (question.status !== "open") continue;
    const paths = uniquePaths([question.path, ...(question.about ? [question.about] : [])]);
    findings.push({
      id: findingId("research-gap", "open-question", paths),
      category: "research-gap",
      severity: "info",
      confidence: "high",
      epistemicStatus: "observation",
      title: "Research question remains open",
      rationale: `The captured research question “${question.question}” is still marked open.`,
      paths,
      verification: "Investigate the question and mark it resolved only after recording the supporting evidence.",
    });
  }

  for (const claim of snapshot.claims) {
    const supporting = claim.supporting.filter((path) => {
      const item = evidence.get(path);
      return isTrustedEvidence(item, item ? sources.get(item.source) : undefined);
    });
    const challenging = claim.challenging.filter((path) => {
      const item = evidence.get(path);
      return isTrustedEvidence(item, item ? sources.get(item.source) : undefined);
    });
    if (claim.reviewState === "reviewed" && supporting.length > 0 && challenging.length === 0) {
      const paths = uniquePaths([claim.path, ...supporting]);
      findings.push({
        id: findingId("research-gap", "no-trusted-counterevidence", paths),
        category: "research-gap",
        severity: "info",
        confidence: "high",
        epistemicStatus: "suggested-investigation",
        title: "Reviewed claim has no trusted counterevidence",
        rationale: "The reviewed claim has trusted supporting evidence but no reviewed, locatable, non-stale counterevidence captured as a challenge.",
        paths,
        verification: "Search for counterevidence and record any relevant challenge, including its exact locator and review state.",
      });
    }
    const trustedSources = uniquePaths([...supporting, ...challenging].flatMap((path) => {
      const item = evidence.get(path);
      return item ? [item.source] : [];
    }));
    if (claim.reviewState === "reviewed" && trustedSources.length === 1) {
      const paths = uniquePaths([claim.path, ...supporting, ...challenging, ...trustedSources]);
      findings.push({
        id: findingId("research-gap", "single-trusted-source", paths),
        category: "research-gap",
        severity: "info",
        confidence: "high",
        epistemicStatus: "observation",
        title: "Reviewed claim relies on one trusted source",
        rationale: "All trusted evidence currently linked to this reviewed claim comes from one captured source, so source diversity is limited.",
        paths,
        verification: "Look for relevant independent sources and capture their evidence before changing the claim confidence.",
      });
    }
    if (supporting.length === 0 || challenging.length === 0) continue;

    const paths = uniquePaths([claim.path, ...supporting, ...challenging]);
    findings.push({
      id: findingId("contradiction", "trusted-support-and-challenge", paths),
      category: "contradiction",
      severity: "warning",
      confidence: "high",
      epistemicStatus: "observation",
      title: "Claim has supporting and challenging evidence",
      rationale: "This claim links to reviewed, locatable, non-stale supporting and challenging evidence. The captured evidence differs, but this rule does not decide which evidence carries more weight.",
      paths,
      verification: "Review the cited excerpts, locators, and source records together before resolving the claim.",
    });

    const sourceKinds = uniquePaths([...supporting, ...challenging].flatMap((path) => {
      const item = evidence.get(path);
      const source = item ? sources.get(item.source) : undefined;
      return source ? [source.sourceKind] : [];
    }));
    if (sourceKinds.length > 1) findings.push({
      id: findingId("method-difference", "source-kind", paths),
      category: "method-difference",
      severity: "info",
      confidence: "high",
      epistemicStatus: "observation",
      title: "Compared evidence uses different captured source kinds",
      rationale: `The supporting and challenging evidence comes from captured source kinds ${sourceKinds.join(" and ")}. No uncaptured methodological difference is inferred.`,
      paths,
      verification: "Inspect the source records and capture any additional methodological fields needed for comparison.",
    });
  }

  for (const audit of auditProject(snapshot)) {
    const category = auditCategory(audit, snapshot);
    findings.push({
      id: findingId(category, `audit-${audit.code}`, [audit.path]),
      category,
      severity: audit.severity,
      confidence: "high",
      epistemicStatus: "observation",
      title: `Research audit: ${audit.code}`,
      rationale: audit.explanation,
      paths: [audit.path],
      verification: audit.repair,
    });
  }

  return stableFindings(findings);
}

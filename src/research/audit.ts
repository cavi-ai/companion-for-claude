import { compareCodeUnits, isStaleEvidence, type ProjectSnapshot } from "./graph";

export interface AuditFinding {
  code: "missing-locator" | "unreviewed-evidence" | "unreviewed-claim" | "rejected-claim" | "unsupported-claim" | "broken-reference" | "unused-evidence" | "stale-evidence" | "invalid-record";
  severity: "error" | "warning" | "info";
  path: string;
  explanation: string;
  repair: string;
}

const severityOrder: Record<AuditFinding["severity"], number> = { error: 0, warning: 1, info: 2 };

export function auditProject(snapshot: ProjectSnapshot): AuditFinding[] {
  const findings: AuditFinding[] = snapshot.issues.map((issue) => ({
    code: "invalid-record",
    severity: "error",
    path: issue.path,
    explanation: `${issue.code}: ${issue.message}`,
    repair: "Repair the research frontmatter so the note can be parsed into the project graph.",
  }));
  const sources = new Map(snapshot.sources.map((source) => [source.path, source]));
  const evidence = new Map(snapshot.evidence.map((item) => [item.path, item]));
  const claims = new Set(snapshot.claims.map((claim) => claim.path));
  const projectPaths = new Set([
    snapshot.project.path,
    ...snapshot.sources.map(({ path }) => path),
    ...snapshot.evidence.map(({ path }) => path),
    ...snapshot.claims.map(({ path }) => path),
    ...snapshot.questions.map(({ path }) => path),
    ...snapshot.documents.map(({ path }) => path),
  ]);
  const usedEvidence = new Set<string>();

  for (const item of snapshot.evidence) {
    const source = sources.get(item.source);
    if (!source) findings.push({ code: "broken-reference", severity: "error", path: item.path, explanation: `Evidence references missing source ${item.source}.`, repair: "Link the evidence to an existing source record or restore the missing source." });
    if (!item.locatorKind || !item.locatorValue?.trim()) findings.push({ code: "missing-locator", severity: "warning", path: item.path, explanation: "Evidence does not have both a locator kind and locator value.", repair: "Add an exact locator kind and value that lets a reviewer find the excerpt." });
    if (item.reviewState === "proposed") findings.push({ code: "unreviewed-evidence", severity: "warning", path: item.path, explanation: "Proposed evidence has not been reviewed by a person.", repair: "Verify the excerpt and locator, then mark the evidence reviewed or rejected." });
    if (isStaleEvidence(item, source)) findings.push({ code: "stale-evidence", severity: "warning", path: item.path, explanation: "The source content fingerprint differs from the fingerprint captured with this evidence.", repair: "Re-open the current source, verify the excerpt and locator, and update the captured fingerprint." });
  }

  for (const claim of snapshot.claims) {
    if (claim.reviewState === "proposed") findings.push({ code: "unreviewed-claim", severity: "warning", path: claim.path, explanation: "Proposed claim has not been reviewed and cannot be used in a trusted outline.", repair: "Review the proposition and evidence relationships, then mark the claim reviewed or rejected." });
    if (claim.reviewState === "rejected") findings.push({ code: "rejected-claim", severity: "error", path: claim.path, explanation: "Rejected claim cannot be used in a trusted outline.", repair: "Remove the claim from outline selections or review it again before marking it reviewed." });
    for (const [relation, paths] of [["supporting", claim.supporting], ["challenging", claim.challenging], ["contextual", claim.contextual]] as const) {
      for (const path of paths) {
        usedEvidence.add(path);
        if (!evidence.has(path)) findings.push({ code: "broken-reference", severity: "error", path: claim.path, explanation: `Claim has a ${relation} reference to missing evidence ${path}.`, repair: "Link the claim to an existing evidence card or remove the broken reference." });
      }
    }
    if (claim.trustedSupportCount === 0) findings.push({ code: "unsupported-claim", severity: "error", path: claim.path, explanation: "Claim has no trusted supporting evidence.", repair: "Add supporting evidence that is reviewed, locatable, linked to a valid source, and not stale." });
  }

  for (const document of snapshot.documents) {
    for (const path of document.claims) if (!claims.has(path)) findings.push({ code: "broken-reference", severity: "error", path: document.path, explanation: `Document references missing claim ${path}.`, repair: "Link the document to an existing claim or remove the broken reference." });
  }
  for (const question of snapshot.questions) {
    if (question.about && !projectPaths.has(question.about)) findings.push({ code: "broken-reference", severity: "error", path: question.path, explanation: `Question references missing or out-of-project target ${question.about}.`, repair: "Link the question to a record in this research project or remove the broken reference." });
  }
  for (const item of snapshot.evidence) if (!usedEvidence.has(item.path)) findings.push({ code: "unused-evidence", severity: "info", path: item.path, explanation: "Evidence is not connected to any claim.", repair: "Connect the evidence to a claim as supporting, challenging, or contextual, or archive it." });

  return findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code));
}

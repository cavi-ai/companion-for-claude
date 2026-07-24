import { isStaleEvidence, isTrustedEvidence, type ProjectClaim, type ProjectSnapshot } from "./graph";
import type { EvidenceRecord, EvidenceRelation } from "./types";
import { buildFrontmatter } from "../indexing/frontmatter";
import { citationKeyForSource } from "./draftGrounding";
import { renderDraftSection, type DraftSectionEnvelope } from "./draftSections";

function evidence(snapshot: ProjectSnapshot, path: string): EvidenceRecord {
  const item = snapshot.evidence.find((candidate) => candidate.path === path);
  if (!item) throw new Error(`Evidence is not part of project: ${path}`);
  return item;
}

function matrixEvidence(snapshot: ProjectSnapshot, relation: EvidenceRelation, path: string): string {
  const item = evidence(snapshot, path);
  const source = snapshot.sources.find((candidate) => candidate.path === item.source);
  if (!source) throw new Error(`Source is not part of project: ${item.source}`);
  const trust = isTrustedEvidence(item, source) ? "trusted" : isStaleEvidence(item, source) ? "stale; untrusted" : "untrusted";
  const locator = item.locatorKind && item.locatorValue ? `${item.locatorKind} ${item.locatorValue}` : "locator missing";
  const fingerprint = item.sourceFingerprint ?? "fingerprint missing";
  return `${relation}: [[${item.path}|${item.title}]] (${item.reviewState}; ${trust}; source [[${source.path}|${source.title}]]; ${locator}; ${fingerprint})`;
}

function renderEvidence(snapshot: ProjectSnapshot, relation: EvidenceRelation, path: string): string[] {
  const item = evidence(snapshot, path);
  const source = snapshot.sources.find((candidate) => candidate.path === item.source);
  if (!source) throw new Error(`Source is not part of project: ${item.source}`);
  return [
    `- **${item.title}** (${relation}; ${item.reviewState})`,
    `  - Evidence: [[${item.path}]]`,
    `  - Source: [[${source.path}]]`,
    `  - Locator: ${item.locatorKind ?? "missing"} ${item.locatorValue ?? "missing"}`,
    `  - Source fingerprint: ${item.sourceFingerprint ? `\`${item.sourceFingerprint}\`` : "not captured"}`,
    ...item.excerpt.split("\n").map((line) => `  > ${line}`),
  ];
}

function exclusion(snapshot: ProjectSnapshot, relation: EvidenceRelation, path: string): string {
  const item = evidence(snapshot, path);
  const source = snapshot.sources.find((candidate) => candidate.path === item.source);
  const reasons = [
    item.reviewState !== "reviewed" ? item.reviewState : undefined,
    !item.locatorKind || !item.locatorValue?.trim() ? "locator missing" : undefined,
    !source ? "source missing" : undefined,
    isStaleEvidence(item, source) ? "stale" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
  return `- [[${item.path}|${item.title}]] (${relation}; excluded: ${reasons.join(", ") || "untrusted"})`;
}

function renderRelation(snapshot: ProjectSnapshot, relation: EvidenceRelation, paths: string[]): { included: string[]; excluded: string[] } {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const path of paths) {
    const item = evidence(snapshot, path);
    const source = snapshot.sources.find((candidate) => candidate.path === item.source);
    if (isTrustedEvidence(item, source)) included.push(...renderEvidence(snapshot, relation, path));
    else excluded.push(exclusion(snapshot, relation, path));
  }
  return { included, excluded };
}

function claim(snapshot: ProjectSnapshot, path: string): ProjectClaim {
  const item = snapshot.claims.find((candidate) => candidate.path === path);
  if (!item) throw new Error(`Claim is not part of project: ${path}`);
  return item;
}

function sectionId(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) { hash ^= path.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  const name = (path.replace(/\.md$/i, "").split("/").pop() ?? "section").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
  return `${name}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function outlineEnvelope(snapshot: ProjectSnapshot, item: ProjectClaim): DraftSectionEnvelope {
  const paths = [...item.supporting, ...item.challenging, ...item.contextual];
  const trusted = paths.flatMap((path) => {
    const evidence = snapshot.evidence.find((candidate) => candidate.path === path);
    const source = evidence ? snapshot.sources.find((candidate) => candidate.path === evidence.source) : undefined;
    return evidence && source && isTrustedEvidence(evidence, source) ? [{ evidence, source }] : [];
  });
  const citations = [...new Map(trusted.map(({ source }) => [source.path, { key: citationKeyForSource(source), sourcePath: source.path }])).values()];
  return {
    id: sectionId(item.path),
    claimPaths: [item.path],
    evidence: trusted.map(({ evidence }) => ({ path: evidence.path, fingerprint: evidence.sourceFingerprint ?? "fingerprint-missing" })),
    citations,
    provider: "companion",
    model: "evidence-outline-v1",
    generatedAt: "outline",
  };
}

export function renderSynthesisMatrix(snapshot: ProjectSnapshot): string {
  const rows = snapshot.claims.map((item) => [
    `[[${item.path}|${item.title}]]`,
    item.supporting.map((path) => matrixEvidence(snapshot, "supports", path)).join("<br>") || "—",
    item.challenging.map((path) => matrixEvidence(snapshot, "challenges", path)).join("<br>") || "—",
    item.contextual.map((path) => matrixEvidence(snapshot, "contextualizes", path)).join("<br>") || "—",
  ].map((cell) => cell.replaceAll("|", "\\|")).join(" | "));
  return ["| Claim | Supports | Challenges | Contextualizes |", "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row} |`)].join("\n");
}

export function renderEvidenceOutline(snapshot: ProjectSnapshot, claimPaths: string[]): string {
  const claims = claimPaths.map((path) => claim(snapshot, path));
  const unsafe = claims.find(({ reviewState }) => reviewState !== "reviewed");
  if (unsafe) throw new Error(`Cannot create a trusted outline from ${unsafe.reviewState} claim: ${unsafe.path}. Review the claim first or remove it from the selection.`);
  const sections = claims.map((item) => {
    const supporting = renderRelation(snapshot, "supports", item.supporting);
    const challenging = renderRelation(snapshot, "challenges", item.challenging);
    const contextual = renderRelation(snapshot, "contextualizes", item.contextual);
    const excluded = [...supporting.excluded, ...challenging.excluded, ...contextual.excluded];
    const section = [
    `## ${item.title}`,
    "",
    item.proposition,
    "",
    `Confidence: ${item.confidence}; review state: ${item.reviewState}.`,
    ...(item.limitations.length ? ["", `Limitations: ${item.limitations.join("; ")}`] : []),
    "", "### Supporting evidence", "", ...supporting.included,
    "", "### Challenging evidence", "", ...challenging.included,
    "", "### Contextual evidence", "", ...contextual.included,
    ...(excluded.length ? ["", "### Excluded evidence", "", ...excluded] : []), "",
    ].join("\n");
    return renderDraftSection(outlineEnvelope(snapshot, item), section);
  });
  const frontmatter = buildFrontmatter({ title: `${snapshot.project.title} — Evidence-backed outline`, type: "research-document", project: `[[${snapshot.project.path}]]`, document_kind: "outline", claims: claims.map(({ path }) => `[[${path}]]`) });
  return [frontmatter, "", `# ${snapshot.project.title} — Evidence-backed outline`, "", ...sections].join("\n");
}

import { claimOrder } from "./argument";
import type { AuditFinding } from "./audit";
import { recordBasename, type ProjectSnapshot } from "./graph";
import type { SectionSummary } from "./sectionStatus";
import type { ResearchProjectRecord } from "./types";

export type NextStepKind = "chat" | "draft-section" | "check" | "extract" | "build-outline" | "add-source";

export interface NextStep {
  id: string;
  label: string;
  kind: NextStepKind;
  path?: string;
  sectionId?: string;
  prompt?: string;
}

export interface NextStepInput {
  snapshot: ProjectSnapshot;
  audit: AuditFinding[];
  sections?: SectionSummary[];
  webSearch: boolean;
}

const MAX_STEPS = 3;

export function shortTitle(title: string, max = 48): string {
  if (title.length <= max) return title;
  const space = title.lastIndexOf(" ", max - 1);
  return `${(space > max / 2 ? title.slice(0, space) : title.slice(0, max - 1)).trimEnd()}…`;
}

export function buildResearchAgentPrompt(project: Pick<ResearchProjectRecord, "path" | "question">, instruction: string): string {
  return [
    `Research project: [[${project.path}]]`,
    `Question: ${project.question}`,
    'Use the research_* tools. Create new evidence and claims with review_state "proposed"; I check them in the Research view.',
    `Task: ${instruction.trim()}`,
  ].join("\n");
}

export function nextSteps(input: NextStepInput): NextStep[] {
  const { snapshot, audit, sections = [], webSearch } = input;
  const chat = (id: string, label: string, instruction: string, path?: string): NextStep => ({ id, label, kind: "chat", ...(path ? { path } : {}), prompt: buildResearchAgentPrompt(snapshot.project, instruction) });
  const claims = claimOrder(snapshot);
  const reviewed = claims.filter(({ reviewState }) => reviewState === "reviewed");
  const rules: Array<() => NextStep | undefined> = [
    () => {
      const stale = audit.find(({ code }) => code === "stale-evidence");
      if (!stale) return undefined;
      const title = snapshot.evidence.find(({ path }) => path === stale.path)?.title ?? recordBasename(stale.path);
      return { id: `recheck:${stale.path}`, label: `Re-check "${shortTitle(title)}"`, kind: "check", path: stale.path };
    },
    () => {
      const pending = [
        ...snapshot.evidence.filter(({ reviewState }) => reviewState === "proposed"),
        ...snapshot.evidence.filter(({ reviewState, locatorKind, locatorValue }) => reviewState === "reviewed" && (!locatorKind || !locatorValue?.trim())),
        ...claims.filter(({ reviewState }) => reviewState === "proposed"),
      ];
      const first = pending[0];
      if (!first) return undefined;
      return { id: `check:${first.path}`, label: `Check "${shortTitle(first.title)}"${pending.length > 1 ? ` and ${pending.length - 1} more` : ""}`, kind: "check", path: first.path };
    },
    () => {
      const section = sections.find(({ state }) => state === "outline" || state === "changed");
      if (!section) return undefined;
      return { id: `draft:${section.id}`, label: `${section.state === "changed" ? "Redraft" : "Draft"} "${shortTitle(section.heading)}"`, kind: "draft-section", sectionId: section.id, path: section.claimPath };
    },
    () => {
      const claim = reviewed.find(({ trustedSupportCount }) => trustedSupportCount < 2);
      return claim && chat(`support:${claim.path}`, `Find more support for "${shortTitle(claim.title)}"`, `Find more support for the claim "${claim.title}" ([[${claim.path}]]). Search the project's sources first, then the web if it is enabled. Capture each supporting passage with research_evidence_capture and link it with research_claim_link as supports.`, claim.path);
    },
    () => {
      const claim = reviewed.find(({ challenging }) => challenging.length === 0);
      return claim && chat(`counter:${claim.path}`, `Look for evidence against "${shortTitle(claim.title)}"`, `Look for evidence that challenges the claim "${claim.title}" ([[${claim.path}]]). Capture each passage with research_evidence_capture and link it with research_claim_link as challenges. If nothing credible challenges it, say so and change nothing.`, claim.path);
    },
    () => (snapshot.documents.length || !reviewed.some(({ trustedSupportCount }) => trustedSupportCount > 0)) ? undefined : { id: "build-outline", label: "Build the outline", kind: "build-outline" },
    () => {
      const read = new Set(snapshot.evidence.map(({ source }) => source));
      const source = snapshot.sources.find(({ path }) => !read.has(path));
      return source && { id: `extract:${source.path}`, label: `Pull passages from "${shortTitle(source.title)}"`, kind: "extract", path: source.path };
    },
    () => {
      if (snapshot.sources.length) return undefined;
      return webSearch
        ? chat("find-sources", "Find sources for this question", "Find sources that answer the project question. Import the 3 to 5 most relevant with research_source_import.")
        : { id: "add-source", label: "Add a first source", kind: "add-source" };
    },
    () => reviewed.length >= 2 ? chat("briefing", "Brief me on where the argument stands", "Brief me on where the argument stands: which claims are strong, which are thin or challenged, and what to do next. Read the project with research_project_read and research_audit. Change no notes.") : undefined,
  ];
  const steps: NextStep[] = [];
  for (const rule of rules) {
    if (steps.length === MAX_STEPS) break;
    const step = rule();
    if (step) steps.push(step);
  }
  return steps;
}

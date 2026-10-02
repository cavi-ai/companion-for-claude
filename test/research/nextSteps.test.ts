import { describe, expect, it } from "vitest";
import { auditProject } from "../../src/research/audit";
import { buildProjectSnapshot } from "../../src/research/graph";
import { buildResearchAgentPrompt, nextSteps, shortTitle } from "../../src/research/nextSteps";
import type { SectionSummary } from "../../src/research/sectionStatus";
import type { ClaimRecord, ResearchRecord } from "../../src/research/types";

const P = "Research/Audio LLMs/Project.md";
const project: ResearchRecord = { path: P, title: "Audio LLMs and Training Research", type: "research-project", project: P, question: "How are LLMs trained and architected for audio?", stage: "frame", status: "active" };
const papers = ["AudioLM", "EnCodec", "Moshi", "MusicLM", "VALL-E", "Whisper"];
const sources = papers.map((name): ResearchRecord => ({ path: `Research/Audio LLMs/Sources/${name}.md`, title: name, type: "research-source", project: P, sourceKind: "web" }));
const evidence = papers.map((name): ResearchRecord => ({ path: `Research/Audio LLMs/Evidence/${name} passage.md`, title: `${name} passage`, type: "evidence", project: P, source: `Research/Audio LLMs/Sources/${name}.md`, locatorKind: "quote", locatorValue: "Abstract", excerpt: `${name} abstract`, reviewState: "reviewed" }));
const ev = (name: string) => `Research/Audio LLMs/Evidence/${name} passage.md`;
const claim = (title: string, supports: string[], over: Partial<ClaimRecord> = {}): ClaimRecord => ({ path: `Research/Audio LLMs/Claims/${title}.md`, title, type: "claim", project: P, proposition: title, confidence: "high", reviewState: "reviewed", supports, challenges: [], contextualizes: [], limitations: ["Abstracts only"], ...over });
const discrete = claim("Discrete neural audio codecs are the dominant tokenization strategy for audio LLMs", [ev("AudioLM"), ev("EnCodec"), ev("VALL-E"), ev("Moshi")]);
const single = claim("No single tokenizer satisfies both fidelity and long-term coherence", [ev("AudioLM"), ev("MusicLM")]);
const paradigms = claim("Two competing training paradigms", [ev("Whisper"), ev("AudioLM"), ev("VALL-E"), ev("MusicLM")], { contextualizes: [ev("Moshi")] });
const outline: ResearchRecord = { path: "Research/Audio LLMs/Documents/Outline.md", title: "Outline", type: "research-document", project: P, documentKind: "outline", claims: [discrete.path, single.path, paradigms.path] };
const sections: SectionSummary[] = [discrete, single, paradigms].map(({ path, title }, index) => ({ id: `s${index}`, heading: title, claimPath: path, state: "outline" }));
const steps = (records: ResearchRecord[], extra: Partial<Parameters<typeof nextSteps>[0]> = {}) => {
  const snapshot = buildProjectSnapshot(P, records, []);
  return nextSteps({ snapshot, audit: auditProject(snapshot), webSearch: false, ...extra });
};

describe("nextSteps", () => {
  it("offers the three spec steps for the Audio LLMs project", () => {
    const result = steps([project, ...sources, ...evidence, discrete, single, paradigms, outline], { sections });
    expect(result.map(({ label, kind }) => [label, kind])).toEqual([
      ['Draft "Discrete neural audio codecs are the dominant…"', "draft-section"],
      ['Look for evidence against "Discrete neural audio codecs are the dominant…"', "chat"],
      ["Brief me on where the argument stands", "chat"],
    ]);
    expect(result[0]?.sectionId).toBe("s0");
    expect(result[1]?.prompt).toBe([
      `Research project: [[${P}]]`,
      "Question: How are LLMs trained and architected for audio?",
      'Use the research_* tools. Create new evidence and claims with review_state "proposed"; I check them in the Research view.',
      `Task: Look for evidence that challenges the claim "${discrete.title}" ([[${discrete.path}]]). Capture each passage with research_evidence_capture and link it with research_claim_link as challenges. If nothing credible challenges it, say so and change nothing.`,
    ].join("\n"));
  });

  it("puts checks before drafting and counts the rest", () => {
    const proposed = ({ ...evidence[0]!, reviewState: "proposed" }) as ResearchRecord;
    const result = steps([project, ...sources, proposed, ...evidence.slice(1), claim("Fresh", [ev("EnCodec")], { reviewState: "proposed" })]);
    expect(result[0]).toMatchObject({ kind: "check", label: 'Check "AudioLM passage" and 1 more', path: ev("AudioLM") });
  });

  it("re-checks stale evidence first", () => {
    const staleSource = ({ ...sources[0]!, contentFingerprint: "sha256:new" }) as ResearchRecord;
    const staleEvidence = ({ ...evidence[0]!, sourceFingerprint: "sha256:old" }) as ResearchRecord;
    expect(steps([project, staleSource, ...sources.slice(1), staleEvidence, ...evidence.slice(1)])[0]).toMatchObject({ kind: "check", label: 'Re-check "AudioLM passage"' });
  });

  it("redrafts a changed section", () => {
    const changed = sections.map((section, index) => ({ ...section, state: index === 1 ? "changed" as const : "drafted" as const }));
    const result = steps([project, ...sources, ...evidence, discrete, single, paradigms, outline], { sections: changed });
    expect(result[0]).toMatchObject({ kind: "draft-section", label: 'Redraft "No single tokenizer satisfies both fidelity and…"', sectionId: "s1" });
  });

  it("asks for more support for a thin claim and builds the outline when none exists", () => {
    const thin = claim("Thin claim", [ev("Whisper")]);
    const result = steps([project, ...sources, ...evidence, thin, single]);
    expect(result.map(({ label }) => label)).toEqual(['Find more support for "Thin claim"', 'Look for evidence against "No single tokenizer satisfies both fidelity and…"', "Build the outline"]);
  });

  it("starts an empty project", () => {
    expect(steps([project])).toEqual([{ id: "add-source", label: "Add a first source", kind: "add-source" }]);
    expect(steps([project], { webSearch: true })[0]).toMatchObject({ kind: "chat", label: "Find sources for this question" });
  });

  it("pulls passages from an unread source", () => {
    expect(steps([project, ...sources])[0]).toMatchObject({ kind: "extract", label: 'Pull passages from "AudioLM"', path: sources[0]!.path });
  });

  it("never returns more than three", () => {
    const thin = claim("Thin claim", [ev("Whisper")]);
    expect(steps([project, ...sources, ({ ...evidence[0]!, reviewState: "proposed" }) as ResearchRecord, ...evidence.slice(1), thin, single, discrete]).length).toBe(3);
  });
});

describe("shortTitle and prompt", () => {
  it("cuts at a word boundary", () => {
    expect(shortTitle("Discrete neural audio codecs are the dominant tokenization strategy for audio LLMs")).toBe("Discrete neural audio codecs are the dominant…");
    expect(shortTitle("Short")).toBe("Short");
  });
  it("trims the instruction", () => {
    expect(buildResearchAgentPrompt({ path: "P.md", question: "Q?" }, "  do it  ").endsWith("Task: do it")).toBe(true);
  });
});

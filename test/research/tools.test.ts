import { describe, expect, it, vi } from "vitest";
import { ResearchTools } from "../../src/research/tools";

function repository() {
  return {
    loadProject: vi.fn().mockResolvedValue({ project: { path: "P/Project.md", title: "P", question: "Why?", stage: "frame", status: "active" }, sources: [], evidence: [], claims: [], questions: [], documents: [], issues: [], health: { claimCount: 0, trustedSupportCount: 0, supportedClaimCount: 0 } }),
    createEvidence: vi.fn().mockResolvedValue({ path: "P/Evidence/E.md" }),
    reviewEvidence: vi.fn(),
    createClaim: vi.fn().mockResolvedValue({ path: "P/Claims/C.md" }),
    linkClaimEvidence: vi.fn().mockResolvedValue(undefined),
    createOutline: vi.fn().mockResolvedValue({ path: "P/Documents/Outline.md" }),
    createProject: vi.fn().mockResolvedValue({ path: "Research/P/Project.md" }),
    importSource: vi.fn().mockResolvedValue({ kind: "created", path: "Research/P/Sources/S.md" }),
  };
}

describe("ResearchTools", () => {
  it("defines compact read/audit tools and write-gated research mutations", () => {
    const names = new ResearchTools(repository() as never).definitions().map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["research_project_create", "research_source_import", "research_project_read", "research_evidence_capture", "research_evidence_review", "research_claim_create", "research_claim_link", "research_audit", "research_outline_generate"]));
    expect(names).not.toEqual(expect.arrayContaining(["research_evidence_create", "research_outline_create"]));
  });

  it.each(["research_evidence_capture", "research_evidence_create"])("dispatches %s to evidence creation", async (name) => {
    const repo = repository();
    await new ResearchTools(repo as never).call(name, { project: "P/Project.md", source: "P/Sources/S.md", title: "E", excerpt: "x" });
    expect(repo.createEvidence).toHaveBeenCalledWith(expect.objectContaining({ reviewState: "proposed" }));
  });

  it.each(["research_outline_generate", "research_outline_create"])("dispatches %s to outline creation", async (name) => {
    const repo = repository();
    await new ResearchTools(repo as never).call(name, { project: "P/Project.md", claims: ["P/Claims/C.md"] });
    expect(repo.createOutline).toHaveBeenCalledWith("P/Project.md", ["P/Claims/C.md"]);
  });

  it("reviews evidence through the dedicated operation", async () => {
    const repo = repository();
    repo.reviewEvidence.mockResolvedValue({ path: "P/Evidence/E.md", reviewState: "reviewed" });
    expect(JSON.parse(await new ResearchTools(repo as never).call("research_evidence_review", { evidence: "P/Evidence/E.md", review_state: "reviewed" }))).toEqual({ path: "P/Evidence/E.md", review_state: "reviewed" });
    await expect(new ResearchTools(repo as never).call("research_evidence_review", { evidence: "P/Evidence/E.md", review_state: "proposed" })).rejects.toThrow(/review state/i);
  });

  it("validates and delegates project creation and metadata/text source import", async () => {
    const repo = repository();
    const tools = new ResearchTools(repo as never);
    await tools.call("research_project_create", { title: "Alpha", question: "Why?", folder: "Research/Alpha", audience: "Reviewers" });
    expect(repo.createProject).toHaveBeenCalledWith({ title: "Alpha", question: "Why?", folder: "Research/Alpha", audience: "Reviewers" });
    await tools.call("research_source_import", { project: "Research/Alpha/Project.md", title: "Paper", source_kind: "doi", doi: "10.1/x", captured_text: "Canonical text", authors: ["A"] });
    expect(repo.importSource).toHaveBeenCalledWith("Research/Alpha/Project.md", expect.objectContaining({ sourceKind: "doi", capturedContent: "Canonical text", authors: ["A"] }));
  });

  it("auto-captures web sources when no captured_text is given", async () => {
    const repo = repository();
    const capture = vi.fn().mockResolvedValue({ markdown: "# Clean article", author: "Ada Lovelace", published: "2026-01-05" });
    const tools = new ResearchTools(repo as never, capture);
    const result = JSON.parse(await tools.call("research_source_import", { project: "P/Project.md", title: "Post", source_kind: "web", url: "https://example.test/post" }));
    expect(capture).toHaveBeenCalledWith("https://example.test/post");
    expect(repo.importSource).toHaveBeenCalledWith("P/Project.md", expect.objectContaining({
      sourceKind: "web", capturedContent: "# Clean article", authors: ["Ada Lovelace"], published: "2026-01-05",
    }));
    expect(result.captured).toBe(true);
  });

  it("keeps caller-provided capture and metadata over auto-capture", async () => {
    const repo = repository();
    const capture = vi.fn().mockResolvedValue({ markdown: "# Should not be used" });
    const tools = new ResearchTools(repo as never, capture);
    await tools.call("research_source_import", { project: "P/Project.md", title: "Post", source_kind: "web", url: "https://example.test/post", captured_text: "Caller text" });
    expect(capture).not.toHaveBeenCalled();
    expect(repo.importSource).toHaveBeenCalledWith("P/Project.md", expect.objectContaining({ capturedContent: "Caller text" }));
  });

  it("falls back to metadata-only import when web capture fails", async () => {
    const repo = repository();
    const capture = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    const tools = new ResearchTools(repo as never, capture);
    const result = JSON.parse(await tools.call("research_source_import", { project: "P/Project.md", title: "Post", source_kind: "web", url: "https://example.test/post" }));
    expect(repo.importSource).toHaveBeenCalledWith("P/Project.md", expect.not.objectContaining({ capturedContent: expect.anything() }));
    expect(result.captured).toBe(false);
  });

  it("does not attempt capture for non-web kinds or without a capture dependency", async () => {
    const repo = repository();
    const capture = vi.fn();
    await new ResearchTools(repo as never, capture).call("research_source_import", { project: "P/Project.md", title: "Paper", source_kind: "doi", url: "https://example.test/doi" });
    expect(capture).not.toHaveBeenCalled();
    const noDep = JSON.parse(await new ResearchTools(repo as never).call("research_source_import", { project: "P/Project.md", title: "Post", source_kind: "web", url: "https://example.test/post" }));
    expect(noDep).not.toHaveProperty("captured");
  });

  it.each([
    ["research_project_create", { title: "A", question: "", folder: "Research/A" }],
    ["research_source_import", { project: "P/Project.md", title: "S", source_kind: "invented" }],
    ["research_source_import", { project: "P/Project.md", title: "S", source_kind: "pdf", captured_text: 4 }],
    ["research_source_import", { project: "P/Project.md", title: "S", source_kind: "pdf", authors: ["A", 4] }],
  ])("rejects malformed public mutation %s before repository mutation", async (name, args) => {
    const repo = repository();
    await expect(new ResearchTools(repo as never).call(name, args)).rejects.toThrow();
    expect(repo.createProject).not.toHaveBeenCalled();
    expect(repo.importSource).not.toHaveBeenCalled();
  });

  it.each([
    [{ project: "P/Project.md", source: "P/Sources/S.md", title: "E", excerpt: "" }, "excerpt"],
    [{ project: "P/Project.md", source: "P/Sources/S.md", title: "E", excerpt: "x", review_state: "reviewed" }, "locator"],
    [{ project: "P/Project.md", source: "P/Sources/S.md", title: "E", excerpt: "x", review_state: "invented" }, "review state"],
  ])("refuses invalid evidence input before repository mutation", async (args, message) => {
    const repo = repository();
    await expect(new ResearchTools(repo as never).call("research_evidence_create", args)).rejects.toThrow(new RegExp(message, "i"));
    expect(repo.createEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["research_evidence_create", { project: " ", source: "S", title: "E", excerpt: "x" }],
    ["research_evidence_create", { project: "P", source: "S", title: "E", excerpt: "x", locator_kind: "line" }],
    ["research_claim_create", { project: "P", title: "C", proposition: "x", confidence: "certain" }],
    ["research_claim_create", { project: "P", title: "C", proposition: "x", supports: "E" }],
    ["research_claim_create", { project: "P", title: "C", proposition: "x", supports: [" "] }],
    ["research_claim_link", { project: "P", claim: "C", evidence: "E", relation: "mentions" }],
    ["research_outline_create", { project: "P", claims: ["C", 4] }],
  ])("rejects malformed %s input before any repository mutation", async (name, args) => {
    const repo = repository();
    await expect(new ResearchTools(repo as never).call(name, args)).rejects.toThrow();
    expect(repo.createEvidence).not.toHaveBeenCalled();
    expect(repo.createClaim).not.toHaveBeenCalled();
    expect(repo.linkClaimEvidence).not.toHaveBeenCalled();
    expect(repo.createOutline).not.toHaveBeenCalled();
  });

  it("delegates evidence creation and lets the repository enforce project source membership", async () => {
    const repo = repository();
    await new ResearchTools(repo as never).call("research_evidence_create", { project: "P/Project.md", source: "Other/S.md", title: "E", excerpt: "x" });
    expect(repo.createEvidence).toHaveBeenCalledWith(expect.objectContaining({ source: "Other/S.md", reviewState: "proposed" }));
  });

  it("returns compact project and audit JSON", async () => {
    const tools = new ResearchTools(repository() as never);
    expect(JSON.parse(await tools.call("research_project_read", { project: "P/Project.md" }))).toEqual(expect.objectContaining({ project: expect.objectContaining({ path: "P/Project.md", title: "P" }), health: expect.any(Object) }));
    expect(JSON.parse(await tools.call("research_audit", { project: "P/Project.md" }))).toEqual([]);
  });

  it("bounds large project reads below the agent result limit while retaining counts and paths", async () => {
    const repo = repository();
    const paths = Array.from({ length: 2_000 }, (_, index) => ({ path: `P/Evidence/Evidence-${index.toString().padStart(4, "0")}.md`, title: `E ${index}` }));
    repo.loadProject.mockResolvedValue({ ...(await repo.loadProject()), evidence: paths, sources: paths, claims: paths, questions: paths, documents: paths });
    const output = await new ResearchTools(repo as never).call("research_project_read", { project: "P/Project.md" });
    const parsed = JSON.parse(output);
    expect(output.length).toBeLessThan(8000);
    expect(parsed.counts.evidence).toBe(2000);
    expect(parsed.paths.evidence.items[0]).toContain("P/Evidence/");
    expect(parsed.paths.evidence.omitted).toBeGreaterThan(0);
  });

  it("returns audit findings with stable rule and exact public shape", async () => {
    const repo = repository();
    repo.loadProject.mockResolvedValue({ ...(await repo.loadProject()), claims: [{ path: "P/C.md", trustedSupportCount: 0, supporting: [], challenging: [], contextual: [] }] });
    const findings = JSON.parse(await new ResearchTools(repo as never).call("research_audit", { project: "P/Project.md" }));
    expect(Object.keys(findings[0])).toEqual(["rule", "code", "severity", "path", "explanation", "repair"]);
    expect(findings[0].rule).toBe("unsupported-claim");
  });
});

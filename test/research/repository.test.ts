import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { ResearchRepository, type ImportSourceInput, type ResearchRepositoryIO } from "../../src/research/repository";
import { draftMarkdownFingerprint, parseDraftSections } from "../../src/research/draftSections";

class MemoryIO implements ResearchRepositoryIO {
  files = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();
  folders = new Set<string>();
  failNextCreate = false;

  async listMarkdown() {
    return [...this.files].filter(([path]) => path.endsWith(".md")).map(([path, content]) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return { path, frontmatter: match ? parse(match[1] ?? "") : undefined, body: match?.[2] ?? content };
    });
  }
  async listProjectMarkdown(projectPath: string) {
    return [...this.files].filter(([path]) => path.endsWith(".md")).map(([path, content]) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return { path, frontmatter: match ? parse(match[1] ?? "") : undefined, body: match?.[2] ?? content };
    }).filter(({ path, frontmatter }) => path === projectPath || String(frontmatter?.project ?? "").replace(/^\[\[|\]\]$/g, "") === projectPath);
  }
  async createWithParents(path: string, content: string) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("atomic create failed");
    }
    if (this.files.has(path) || this.folders.has(path)) throw new Error(`File already exists: ${path}`);
    const parts = path.slice(0, path.lastIndexOf("/")).split("/");
    for (let index = 1; index <= parts.length; index += 1) this.folders.add(parts.slice(0, index).join("/"));
    this.files.set(path, content);
  }
  async readBinary(path: string) {
    const bytes = this.binaryFiles.get(path);
    if (!bytes) throw new Error(`Binary file not found: ${path}`);
    return bytes;
  }
  async updateFrontmatter(path: string, mutator: (frontmatter: Record<string, unknown>) => void) {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) throw new Error(`No frontmatter: ${path}`);
    const frontmatter = parse(match[1] ?? "") as Record<string, unknown>;
    const before = { ...frontmatter };
    mutator(frontmatter);
    let block = match[1] ?? "";
    for (const [key, value] of Object.entries(frontmatter)) {
      if (before[key] !== value) block = block.replace(new RegExp(`^${key}:.*(?:\n  - .*)*`, "m"), `${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
    }
    this.files.set(path, content.replace(match[0], `---\n${block}\n---`));
  }
  async updateText(path: string, updater: (content: string) => string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    this.files.set(path, updater(content));
  }
}

const projectInput = { title: "AI Reviews", question: "How reliable are automated reviews?", folder: "Research/AI Reviews" };

describe("ResearchRepository", () => {
  it("lists research projects deterministically for the Desk switcher", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    await repo.createProject({ title: "Zulu", question: "Z?", folder: "Research/Zulu" });
    await repo.createProject({ title: "Alpha", question: "A?", folder: "Research/Alpha" });
    expect((await repo.listProjects()).map(({ title, path }) => [title, path])).toEqual([
      ["Alpha", "Research/Alpha/Project.md"],
      ["Zulu", "Research/Zulu/Project.md"],
    ]);
  });
  it("uses project-scoped record listing when the IO provides it", async () => {
    const io = new MemoryIO();
    const project = await new ResearchRepository(io).createProject(projectInput);
    const scoped = vi.spyOn(io, "listProjectMarkdown");
    const broad = vi.spyOn(io, "listMarkdown");
    await new ResearchRepository(io).loadProject(project.path);
    expect(scoped).toHaveBeenCalledWith(project.path);
    expect(broad).not.toHaveBeenCalled();
  });
  it("creates a canonical vault-native project without placeholder notes", async () => {
    const io = new MemoryIO();
    const created = await new ResearchRepository(io).createProject(projectInput);
    expect(created.path).toBe("Research/AI Reviews/Project.md");
    expect(created.project).toBe(created.path);
    expect([...io.files.keys()]).toEqual([created.path]);
    expect(io.folders).toEqual(new Set(["Research", "Research/AI Reviews"]));
  });

  it.each([
    { title: "Review article", sourceKind: "web" as const, url: "https://example.test/review", capturedContent: "web capture" },
    { title: "Scanned report", sourceKind: "pdf" as const, asset: "Attachments/report.pdf", capturedContent: new Uint8Array([1, 2, 3]) },
  ])("imports $sourceKind sources idempotently", async (sourceInput) => {
    const io = new MemoryIO();
    if (sourceInput.asset && sourceInput.capturedContent instanceof Uint8Array) io.binaryFiles.set(sourceInput.asset, sourceInput.capturedContent);
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const first = await repo.importSource(project.path, sourceInput);
    const second = await repo.importSource(project.path, sourceInput);
    expect(first).toEqual({ kind: "created", path: `Research/AI Reviews/Sources/${sourceInput.title}.md` });
    expect(second).toEqual({ kind: "duplicate", path: first.path });
  });

  it("reconstructs persisted records from a fresh repository instance", async () => {
    const io = new MemoryIO();
    const first = new ResearchRepository(io);
    const project = await first.createProject(projectInput);
    await first.importSource(project.path, { title: "Paper", sourceKind: "doi", doi: "10.1/test", capturedContent: "paper" });
    const snapshot = await new ResearchRepository(io).loadProject(project.path);
    expect(snapshot.project).toEqual(project);
    expect(snapshot.sources).toHaveLength(1);
  });

  it("derives evidence fingerprints from a source in the target project", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const imported = await repo.importSource(project.path, { title: "Paper", sourceKind: "pdf", asset: "Files/Paper.pdf", capturedContent: "trusted source bytes" });
    if (imported.kind !== "created") throw new Error("expected created source");
    const evidence = await repo.createEvidence({ project: project.path, source: imported.path, title: "Result", excerpt: "It worked.", locatorKind: "page", locatorValue: "4", sourceFingerprint: "sha256:spoofed" } as never);
    expect(evidence.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.sourceFingerprint).not.toBe("sha256:spoofed");
    await expect(repo.createEvidence({ project: project.path, source: "Elsewhere/Source.md", title: "Bad", excerpt: "No." })).rejects.toThrow("Source is not part of project");
  });

  it("computes fingerprints from captured payloads and leaves metadata-only imports unfingerprinted", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const first = await repo.importSource(project.path, { title: "Capture A", sourceKind: "vault", capturedContent: "same payload" });
    const same = await repo.importSource(project.path, { title: "Capture B", sourceKind: "vault", capturedContent: "same payload" });
    const different = await repo.importSource(project.path, { title: "Capture C", sourceKind: "vault", capturedContent: "different payload" });
    await repo.importSource(project.path, { title: "Metadata only", sourceKind: "doi", doi: "10.2/metadata" });
    const spoofed: ImportSourceInput = {
      title: "Spoof attempt", sourceKind: "vault",
      // @ts-expect-error fingerprints are derived by the repository, never supplied by callers
      contentFingerprint: "sha256:caller-controlled",
    };
    await repo.importSource(project.path, spoofed);
    expect(first.kind).toBe("created");
    expect(same).toEqual({ kind: "duplicate", path: first.path });
    expect(different.kind).toBe("created");
    const snapshot = await repo.loadProject(project.path);
    expect(snapshot.sources.find(({ title }) => title === "Capture A")?.contentFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.sources.find(({ title }) => title === "Capture C")?.contentFingerprint).not.toBe(snapshot.sources.find(({ title }) => title === "Capture A")?.contentFingerprint);
    expect(snapshot.sources.find(({ title }) => title === "Metadata only")?.contentFingerprint).toBeUndefined();
    expect(snapshot.sources.find(({ title }) => title === "Spoof attempt")?.contentFingerprint).toBeUndefined();
  });

  it("requires a path for binary captures and derives reconstruction from asset bytes", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    await expect(repo.importSource(project.path, { title: "No asset", sourceKind: "pdf", capturedContent: new Uint8Array([9]) })).rejects.toThrow("requires an asset path");
    io.binaryFiles.set("Files/Paper.pdf", new Uint8Array([1, 2, 3]));
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "pdf", asset: "Files/Paper.pdf", capturedContent: new Uint8Array([9, 9, 9]) });
    if (source.kind !== "created") throw new Error("expected created source");
    const expected = await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]));
    const expectedFingerprint = `sha256:${[...new Uint8Array(expected)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    expect((await new ResearchRepository(io).loadProject(project.path)).sources[0]?.contentFingerprint).toBe(expectedFingerprint);
  });

  it("preserves the note body, comments, and unknown frontmatter when changing review state", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "vault" });
    if (source.kind !== "created") throw new Error("expected source");
    const evidence = await repo.createEvidence({ project: project.path, source: source.path, title: "Evidence", excerpt: "Exact quote." });
    const original = io.files.get(evidence.path)!;
    const customized = original.replace('review_state: "proposed"', '# keep this comment\ncustom_field: "verbatim"\nreview_state: "proposed"').replace("> Exact quote.", "> Exact quote.\n\nUser-authored body.");
    io.files.set(evidence.path, customized);
    const reviewed = await repo.reviewEvidence(evidence.path, "reviewed");
    expect(reviewed.path).toBe(evidence.path);
    expect(reviewed.reviewState).toBe("reviewed");
    expect(io.files.get(evidence.path)).toBe(customized.replace('review_state: "proposed"', "review_state: reviewed"));

    await expect(repo.reviewEvidence(evidence.path, "proposed" as never)).rejects.toThrow(/review target/i);
    await expect(repo.reviewEvidence("Research/Missing/Evidence.md", "reviewed")).rejects.toThrow(/not found/i);
    await expect(repo.reviewEvidence(project.path, "reviewed")).rejects.toThrow(/not evidence/i);
  });

  it("rejects claim evidence relations outside the loaded project", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    await expect(repo.createClaim({ project: project.path, title: "Claim", proposition: "A result", supports: ["Other/Evidence.md"] })).rejects.toThrow("Evidence is not part of project");
    expect(io.files.has("Research/AI Reviews/Claims/Claim.md")).toBe(false);
  });

  it("links evidence through exactly one native relation without disturbing the others", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "pdf" });
    if (source.kind !== "created") throw new Error("expected source");
    const evidence = await repo.createEvidence({ project: project.path, source: source.path, title: "Evidence", excerpt: "Exact." });
    const claim = await repo.createClaim({ project: project.path, title: "Claim", proposition: "Result.", challenges: [evidence.path] });
    await repo.linkClaimEvidence(project.path, claim.path, evidence.path, "supports");
    await repo.linkClaimEvidence(project.path, claim.path, evidence.path, "supports");
    const reloaded = await repo.loadProject(project.path);
    expect(reloaded.claims[0]?.supports).toEqual([evidence.path]);
    expect(reloaded.claims[0]?.challenges).toEqual([evidence.path]);
    expect(reloaded.claims[0]?.contextualizes).toEqual([]);
  });

  it("persists an outline with exact source, locator, fingerprint, and excerpt provenance", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "pdf", capturedContent: "bytes" });
    if (source.kind !== "created") throw new Error("expected source");
    const evidence = await repo.createEvidence({ project: project.path, source: source.path, title: "Evidence", excerpt: "Exact quote.", locatorKind: "page", locatorValue: "0014", reviewState: "reviewed" });
    const claim = await repo.createClaim({ project: project.path, title: "Claim", proposition: "Result.", supports: [evidence.path], reviewState: "reviewed" });
    const outline = await repo.createOutline(project.path, [claim.path]);
    expect(io.files.get(outline.path)).toBe(outline.content);
    expect(outline.content).toContain(`Source: [[${source.path}]]`);
    expect(outline.content).toContain("Locator: page 0014");
    expect(outline.content).toContain("Source fingerprint: `sha256:");
    expect(outline.content).toContain("> Exact quote.");
    expect((await repo.loadProject(project.path)).documents[0]?.claims).toEqual([claim.path]);
  });

  it("atomically accepts one previewed section into the canonical document", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "zotero", zoteroKey: "smith2025", capturedContent: "bytes" });
    if (source.kind !== "created") throw new Error("expected source");
    const evidence = await repo.createEvidence({ project: project.path, source: source.path, title: "Evidence", excerpt: "Exact quote.", locatorKind: "page", locatorValue: "14", reviewState: "reviewed" });
    const claim = await repo.createClaim({ project: project.path, title: "Claim", proposition: "Result.", supports: [evidence.path], reviewState: "reviewed" });
    const outline = await repo.createOutline(project.path, [claim.path]);
    const loaded = await repo.loadDraftSections(outline.path);
    expect(loaded.issues).toEqual([]);
    const preview = loaded.sections[0];
    if (!preview) throw new Error("missing managed section");

    await repo.acceptDraftSection({
      documentPath: outline.path,
      preview,
      envelope: { ...preview.envelope, provider: "anthropic", model: "claude-test", generatedAt: "2026-07-14T20:00:00.000Z", claimFingerprint: "claim-v1" },
      markdown: "The result was observed [@smith2025].",
      currentEvidence: preview.envelope.evidence,
      currentClaimFingerprint: "claim-v1",
    });

    const content = io.files.get(outline.path) ?? "";
    expect(content).toContain("document_kind: draft");
    expect(content).toContain("The result was observed [@smith2025].");
    expect(parseDraftSections(content).sections[0]?.modifiedSinceReview).toBe(false);

    const accepted = parseDraftSections(content).sections[0];
    if (!accepted) throw new Error("missing accepted section");
    const revisionEnvelope = { ...accepted.envelope, generatedAt: "later", revisionIntent: "clarity", revisedFromFingerprint: draftMarkdownFingerprint(accepted.markdown) };
    const packet = { projectPath: project.path, claim: { path: claim.path, title: "Claim", proposition: "Result.", confidence: "moderate" }, limitations: [], evidence: [{ path: evidence.path, relation: "supports" as const, sourcePath: source.path, fingerprint: revisionEnvelope.evidence[0]?.fingerprint ?? "", citationKey: "smith2025", locatorKind: "page", locatorValue: "14", excerpt: "Exact quote." }] };
    const response = { markdown: "Result was observed [@smith2025].", support: [{ passage: "Result was observed [@smith2025].", claimPath: claim.path, evidencePaths: [evidence.path], citationKeys: ["smith2025"] }], claimPreservation: [{ claimPath: claim.path, passage: "Result was observed [@smith2025].", status: "preserved" }], changes: [{ kind: "clarity", severity: "warning", description: "Removes an unnecessary article." }], gaps: [] };
    await expect(repo.acceptRevisionSection({ documentPath: outline.path, preview: accepted, envelope: revisionEnvelope, markdown: response.markdown, currentEvidence: revisionEnvelope.evidence, currentClaimFingerprint: revisionEnvelope.claimFingerprint ?? "", packet, request: { intent: "clarity" }, response: { ...response, changes: [{ kind: "factual-addition", severity: "block", description: "Added a fact." }] } })).rejects.toThrow(/blocked/i);
    await repo.acceptRevisionSection({ documentPath: outline.path, preview: accepted, envelope: revisionEnvelope, markdown: response.markdown, currentEvidence: revisionEnvelope.evidence, currentClaimFingerprint: revisionEnvelope.claimFingerprint ?? "", packet, request: { intent: "clarity" }, response });
    expect(io.files.get(outline.path)).toContain("Result was observed [@smith2025].");
  });

  it("blocks acceptance when reviewed evidence changed after preview", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject(projectInput);
    const source = await repo.importSource(project.path, { title: "Paper", sourceKind: "zotero", zoteroKey: "smith2025", capturedContent: "bytes" });
    if (source.kind !== "created") throw new Error("expected source");
    const evidence = await repo.createEvidence({ project: project.path, source: source.path, title: "Evidence", excerpt: "Exact quote.", locatorKind: "page", locatorValue: "14", reviewState: "reviewed" });
    const claim = await repo.createClaim({ project: project.path, title: "Claim", proposition: "Result.", supports: [evidence.path], reviewState: "reviewed" });
    const outline = await repo.createOutline(project.path, [claim.path]);
    const preview = (await repo.loadDraftSections(outline.path)).sections[0];
    if (!preview) throw new Error("missing managed section");
    const envelope = { ...preview.envelope, evidence: [{ path: evidence.path, fingerprint: "before" }], provider: "anthropic", model: "test", generatedAt: "now" };
    await expect(repo.acceptDraftSection({ documentPath: outline.path, preview, envelope, markdown: "Result [@smith2025].", currentEvidence: [{ path: evidence.path, fingerprint: "after" }], currentClaimFingerprint: "claim" })).rejects.toThrow(/evidence changed/i);
    await expect(repo.acceptDraftSection({ documentPath: outline.path, preview, envelope: { ...envelope, claimFingerprint: "before" }, markdown: "Result [@smith2025].", currentEvidence: envelope.evidence, currentClaimFingerprint: "after" })).rejects.toThrow(/claim changed/i);
  });

  it("leaves no folder or record behind when atomic creation fails", async () => {
    const io = new MemoryIO();
    io.failNextCreate = true;
    await expect(new ResearchRepository(io).createProject(projectInput)).rejects.toThrow("atomic create failed");
    expect(io.files.size).toBe(0);
    expect(io.folders.size).toBe(0);
  });

  it("rejects traversal, noncanonical project paths, and existing user-file collisions", async () => {
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    await expect(repo.createProject({ ...projectInput, folder: "Research/../Escape" })).rejects.toThrow("Unsafe research path");
    const project = await repo.createProject(projectInput);
    await expect(repo.importSource("Research/AI Reviews/Other.md", { title: "Paper", sourceKind: "web" })).rejects.toThrow("Project path must end with /Project.md");
    io.files.set("Research/AI Reviews/Sources/Paper.md", "user content");
    await expect(repo.importSource(project.path, { title: "Paper", sourceKind: "web", url: "https://new.test" })).rejects.toThrow("Research record already exists");
  });
});

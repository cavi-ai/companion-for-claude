import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { auditProject } from "../../src/research/audit";
import { ResearchRepository, type ResearchRepositoryIO } from "../../src/research/repository";

class FixtureVault implements ResearchRepositoryIO {
  readonly files = new Map<string, string>();

  async listMarkdown() {
    return this.notes();
  }

  async listProjectMarkdown(projectPath: string) {
    return this.notes().filter(({ path, frontmatter }) =>
      path === projectPath || unwrapLink(frontmatter?.project) === projectPath);
  }

  async createWithParents(path: string, content: string) {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
  }

  async updateFrontmatter(path: string, mutator: (frontmatter: Record<string, unknown>) => void) {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new Error(`No frontmatter: ${path}`);
    const frontmatter = parseYaml(match[1] ?? "") as Record<string, unknown>;
    mutator(frontmatter);
    const rendered = Object.entries(frontmatter).flatMap(([key, value]) => {
      if (Array.isArray(value)) return value.length ? [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`)] : [`${key}: []`];
      return [`${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`];
    }).join("\n");
    this.files.set(path, `---\n${rendered}\n---\n${match[2] ?? ""}`);
  }

  private notes() {
    return [...this.files].filter(([path]) => path.endsWith(".md")).map(([path, content]) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return { path, frontmatter: match ? parseYaml(match[1] ?? "") : undefined, body: match?.[2] ?? content };
    });
  }
}

function unwrapLink(value: unknown): string {
  return typeof value === "string" ? value.replace(/^\[\[|\]\]$/g, "") : "";
}

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/research/${name}`, import.meta.url)), "utf8");
const metadata = JSON.parse(fixture("zotero-item.json")) as {
  key: string;
  title: string;
  DOI: string;
  url: string;
  date: string;
  publicationTitle: string;
  creators: Array<{ firstName: string; lastName: string }>;
};

async function seededLineage(reviewState: "proposed" | "reviewed" = "reviewed") {
  const io = new FixtureVault();
  const repo = new ResearchRepository(io);
  const project = await repo.createProject({
    title: "Review Reliability",
    question: "When is automated extraction reliable?",
    folder: "Research/Review Reliability",
  });
  const imported = await repo.importSource(project.path, {
    title: metadata.title,
    sourceKind: "zotero",
    zoteroKey: metadata.key,
    doi: metadata.DOI,
    url: metadata.url,
    authors: metadata.creators.map(({ firstName, lastName }) => `${firstName} ${lastName}`),
    published: metadata.date,
    publication: metadata.publicationTitle,
    capturedContent: fixture("paper.md"),
  });
  if (imported.kind !== "created") throw new Error("Expected the fixture source to be created");
  const evidence = await repo.createEvidence({
    project: project.path,
    source: imported.path,
    title: "Cross-domain performance",
    excerpt: "Performance varied substantially across domains.",
    locatorKind: "page",
    locatorValue: "14",
    reviewState,
  });
  const claim = await repo.createClaim({
    project: project.path,
    title: "External validity",
    proposition: "External validity varies by domain.",
    confidence: "moderate",
    reviewState: "reviewed",
  });
  await repo.linkClaimEvidence(project.path, claim.path, evidence.path, "supports");
  return { io, repo, project, source: imported, evidence, claim };
}

describe("Phase 1 evidence lineage", () => {
  it("round-trips collision-prone captured text and reconstructs the same fingerprint", async () => {
    const io = new FixtureVault();
    const repo = new ResearchRepository(io);
    const project = await repo.createProject({ title: "Encoding", question: "Exact?", folder: "Research/Encoding" });
    const capturedContent = "prefix <!-- cavi:capture:start -->\r\nUnicode: café 漢字 😀\n100% literal\r\n<!-- cavi:capture:end --> suffix";
    const imported = await repo.importSource(project.path, { title: "Collision source", sourceKind: "vault", capturedContent });
    if (imported.kind !== "created") throw new Error("Expected source creation");
    const persisted = io.files.get(imported.path) ?? "";
    expect(persisted).toContain(`version=1 chars=${capturedContent.length}`);
    expect(persisted).toContain(capturedContent);
    expect(persisted).toContain("Unicode: café 漢字 😀");
    expect(persisted).not.toContain(encodeURIComponent(capturedContent));

    const reconstructed = await new ResearchRepository(io).loadProject(project.path);
    expect(reconstructed.sources[0]?.capturedContent).toBe(capturedContent);
    expect(reconstructed.sources[0]?.contentFingerprint).toBe((await repo.loadProject(project.path)).sources[0]?.contentFingerprint);
    expect(reconstructed.issues).toEqual([]);
  });

  it("preserves exact reviewed evidence lineage through a native relation, outline, clean audit, and canonical reconstruction", async () => {
    const { io, repo, project, source, evidence, claim } = await seededLineage();
    const outline = await repo.createOutline(project.path, [claim.path]);

    expect(evidence.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(outline.content).toContain("External validity varies by domain.");
    expect(outline.content).toContain("Performance varied substantially across domains.");
    expect(outline.content).toContain("Locator: page 14");
    expect(outline.content).toContain(`Source: [[${source.path}]]`);
    expect(outline.content).toContain(`Source fingerprint: \`${evidence.sourceFingerprint}\``);

    const reconstructed = await new ResearchRepository(io).loadProject(project.path);
    expect(reconstructed.claims[0]?.supporting).toEqual([evidence.path]);
    expect(reconstructed.claims[0]?.trustedSupportCount).toBe(1);
    expect(reconstructed.documents[0]?.claims).toEqual([claim.path]);
    expect(auditProject(reconstructed)).toEqual([]);
  });

  it("invalidates reviewed evidence when the captured source fingerprint changes", async () => {
    const { io, repo, project, source, evidence, claim } = await seededLineage();
    const originalFingerprint = evidence.sourceFingerprint;
    const sourceNote = io.files.get(source.path);
    if (!sourceNote) throw new Error("Expected persisted source note");
    io.files.set(source.path, sourceNote.replace(
      "Performance varied substantially across domains.",
      "Performance varies substantially across domains.",
    ));
    await io.updateFrontmatter(source.path, (frontmatter) => {
      frontmatter.content_fingerprint = originalFingerprint;
    });

    const reconstructed = await repo.loadProject(project.path);
    expect(reconstructed.sources[0]?.contentFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reconstructed.sources[0]?.contentFingerprint).not.toBe(originalFingerprint);
    expect(reconstructed.claims.find(({ path }) => path === claim.path)?.trustedSupportCount).toBe(0);
    expect(auditProject(reconstructed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale-evidence", path: evidence.path }),
      expect.objectContaining({ code: "unsupported-claim", path: claim.path }),
    ]));
    const outline = await repo.createOutline(project.path, [claim.path]);
    expect(outline.content).not.toContain("Performance varied substantially across domains.");
    expect(outline.content).toContain("Excluded evidence");
    expect(outline.content).toContain("stale");
  });

  it("does not count proposed evidence as trusted claim support", async () => {
    const { repo, project, evidence, claim } = await seededLineage("proposed");
    const reconstructed = await repo.loadProject(project.path);

    expect(reconstructed.claims.find(({ path }) => path === claim.path)?.trustedSupportCount).toBe(0);
    expect(auditProject(reconstructed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unreviewed-evidence", path: evidence.path }),
      expect.objectContaining({ code: "unsupported-claim", path: claim.path }),
    ]));
    const outline = await repo.createOutline(project.path, [claim.path]);
    expect(outline.content).not.toContain("Performance varied substantially across domains.");
    expect(outline.content).toContain("Excluded evidence");
    expect(outline.content).toContain("proposed");
  });
});

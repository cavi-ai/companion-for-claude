import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ResearchRepository, type ResearchRepositoryIO } from "../../src/research/repository";

class MemoryIO implements ResearchRepositoryIO {
  files = new Map<string, string>();

  async listMarkdown() {
    return [...this.files].map(([path, content]) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return { path, frontmatter: match ? parse(match[1] ?? "") : undefined, body: match?.[2] ?? content };
    });
  }

  async createWithParents(path: string, content: string) {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
  }

  async updateFrontmatter() { throw new Error("not used"); }
}

async function setup() {
  const io = new MemoryIO();
  const repo = new ResearchRepository(io);
  const project = await repo.createProject({ title: "Discovery", question: "What is known?", folder: "Research/Discovery" });
  return { io, repo, project };
}

describe("discovery source imports", () => {
  it("round-trips discovery metadata without creating evidence or claims", async () => {
    const { io, repo, project } = await setup();
    const result = await repo.importSource(project.path, {
      title: "Discovered paper",
      sourceKind: "doi",
      doi: "10.1000/discovery",
      authors: ["Ada Lovelace", "Grace Hopper"],
      abstract: "A structured abstract.",
      openAccessUrl: "https://archive.example/paper.pdf",
      discoveryProvenance: [
        { adapter: "openalex", externalId: "W123" },
        { adapter: "crossref", externalId: "10.1000/discovery" },
      ],
    });
    expect(result.kind).toBe("created");

    const snapshot = await new ResearchRepository(io).loadProject(project.path);
    expect(snapshot.sources).toEqual([expect.objectContaining({
      abstract: "A structured abstract.",
      openAccessUrl: "https://archive.example/paper.pdf",
      discoveryProvenance: [
        { adapter: "openalex", externalId: "W123" },
        { adapter: "crossref", externalId: "10.1000/discovery" },
      ],
    })]);
    expect(snapshot.evidence).toEqual([]);
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.questions).toEqual([]);
  });

  it("rejects invalid open-access URL protocols", async () => {
    const { repo, project } = await setup();
    await expect(repo.importSource(project.path, {
      title: "Unsafe paper", sourceKind: "web", openAccessUrl: "file:///private/paper.pdf",
    })).rejects.toThrow(/open access URL.*http/i);
  });

  it("clips abstracts at exactly 20,000 characters", async () => {
    const exact = await setup();
    await exact.repo.importSource(exact.project.path, { title: "Exact", sourceKind: "web", abstract: "x".repeat(20_000) });
    expect((await exact.repo.loadProject(exact.project.path)).sources[0]?.abstract).toHaveLength(20_000);

    const overflow = await setup();
    await overflow.repo.importSource(overflow.project.path, { title: "Overflow", sourceKind: "web", abstract: `${"y".repeat(20_000)}overflow` });
    expect((await overflow.repo.loadProject(overflow.project.path)).sources[0]?.abstract).toBe("y".repeat(20_000));
  });

  it("defensively copies authors and discovery provenance", async () => {
    const { repo, project } = await setup();
    const authors = ["Original Author"];
    const provenance = [{ adapter: "arxiv" as const, externalId: "2501.00001" }];
    const importing = repo.importSource(project.path, { title: "Immutable", sourceKind: "arxiv", authors, discoveryProvenance: provenance });
    authors[0] = "Mutated Author";
    provenance[0]!.externalId = "mutated";
    await importing;
    const source = (await repo.loadProject(project.path)).sources[0];
    expect(source?.authors).toEqual(["Original Author"]);
    expect(source?.discoveryProvenance).toEqual([{ adapter: "arxiv", externalId: "2501.00001" }]);
  });
});

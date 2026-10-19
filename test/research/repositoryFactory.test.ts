import { describe, expect, it, vi } from "vitest";
import { App, stringifyYaml } from "obsidian";
import { createResearchRepository } from "../../src/research/repositoryFactory";

const projectPath = "Research/P/Project.md";
const project = { title: "Current project", type: "research-project", project: `[[${projectPath}]]`, question: "Does it hold?", stage: "read", status: "active" };
const note = (frontmatter: Record<string, unknown>, body: string) => `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;

describe("research repository vault reads", () => {
  it("reads frontmatter and body from the same content while metadata lags", async () => {
    const app = new App();
    app.vault.seed(projectPath, note(project, "# Current project"), { frontmatter: { ...project, title: "Old project" } });
    const sourcePath = "Research/P/Sources/S.md";
    const source = { title: "Study", type: "research-source", project: `[[${projectPath}]]`, source_kind: "web", content_fingerprint: "new" };
    app.vault.seed(sourcePath, note(source, "# Source"), { frontmatter: source });
    const evidencePath = "Research/P/Evidence/E.md";
    const evidence = { title: "Result", type: "evidence", project: `[[${projectPath}]]`, source: `[[${sourcePath}]]`, source_fingerprint: "new", locator_kind: "page", locator_value: "4", review_state: "reviewed" };
    app.vault.seed(evidencePath, note(evidence, "> Fresh excerpt."), { frontmatter: { ...evidence, source_fingerprint: "old", review_state: "proposed" } });
    const claim = { title: "Claim", type: "claim", project: `[[${projectPath}]]`, proposition: "It holds.", confidence: "moderate", review_state: "reviewed", supports: [`[[${evidencePath}]]`], challenges: [], contextualizes: [], limitations: [] };
    app.vault.seed("Research/P/Claims/C.md", note(claim, "# Claim"), { frontmatter: claim });
    const repository = createResearchRepository(app, { ensureFolder: async () => undefined });
    const snapshot = await repository.loadProject(projectPath);
    expect(snapshot.project.title).toBe("Current project");
    expect(snapshot.evidence[0]).toMatchObject({ sourceFingerprint: "new", reviewState: "reviewed", excerpt: "Fresh excerpt." });
    expect(snapshot.claims[0]?.trustedSupportCount).toBe(1);
    expect((await repository.listProjects())[0]?.title).toBe("Current project");
  });

  it("does not resurrect removed frontmatter from the metadata cache", async () => {
    const app = new App();
    app.vault.seed(projectPath, "# This is now an ordinary note\n", { frontmatter: project });
    const repository = createResearchRepository(app, { ensureFolder: async () => undefined });
    expect(await repository.listProjects()).toEqual([]);
  });

  it("isolates malformed notes while reporting damaged project records", async () => {
    const app = new App();
    app.vault.seed(projectPath, note(project, "# Project"), { frontmatter: project });
    app.vault.seed("Unrelated.md", "---\ninvalid: [\n---\n", { frontmatter: { title: "Old title" } });
    const damaged = "Research/P/Evidence/Damaged.md";
    app.vault.seed(damaged, "---\ninvalid: [\n---\n\n> Passage\n", { frontmatter: { type: "evidence" } });
    const repository = createResearchRepository(app, { ensureFolder: async () => undefined });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      expect((await repository.listProjects()).map((item) => item.path)).toEqual([projectPath]);
      const snapshot = await repository.loadProject(projectPath);
      expect(snapshot.evidence).toEqual([]);
      expect(snapshot.issues).toContainEqual(expect.objectContaining({ path: damaged }));
    } finally {
      debug.mockRestore();
    }
  });
});

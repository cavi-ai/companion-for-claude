import { describe, expect, it, vi } from "vitest";
import { HealthController, type HealthDeps } from "../../src/health/controller";
import type { ResolvedType } from "../../src/ontology/types";

const taskType: ResolvedType = {
  name: "task", version: 1, lineage: ["task", "entity"],
  properties: [{ key: "status", type: "string", required: true }], relations: [],
};

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    markdownFiles: () => [
      { path: "t.md", frontmatter: { type: "task" } },
      { path: "plain.md", frontmatter: { title: "x" } },
    ],
    unresolvedLinks: () => ({}),
    ontology: () => ({ resolve: (n) => (n === "task" ? taskType : undefined), resolved: () => new Map([["task", taskType]]) }),
    lookupTargetType: () => undefined,
    listProjects: async () => [],
    auditProject: async () => [],
    index: async () => ({ enabled: false, built: false, failed: [] }),
    inboxPending: () => 0,
    companion: () => ({ connection: { backend: "claude", needsCredential: true }, activity: [], bridge: { applicable: false, enabled: false, running: false, port: 0 }, clipper: { applicable: false, status: "current" } }),
    now: () => "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("HealthController", () => {
  it("checks only notes with a string type", async () => {
    const report = await new HealthController(deps()).scan();
    const ontology = report.sections.find((s) => s.id === "ontology")!;
    expect(ontology.count).toBe(1);
    expect(ontology.items[0]!.path).toBe("t.md");
  });

  it("does not flag the plugin's own triage board", async () => {
    const report = await new HealthController(deps({
      markdownFiles: () => [{ path: "Clippings/Triage.md", frontmatter: { type: "triage", source_enriched: true } }],
    })).scan();
    expect(report.sections.find((s) => s.id === "ontology")).toMatchObject({ count: 0, items: [] });
  });

  it("treats an empty registry as not seeded", async () => {
    const report = await new HealthController(deps({ ontology: () => ({ resolve: () => undefined, resolved: () => new Map() }) })).scan();
    expect(report.sections.map((s) => s.id)).not.toContain("ontology");
  });

  it("a failing project audit becomes one error finding and the scan continues", async () => {
    const report = await new HealthController(deps({
      listProjects: async () => [{ path: "A/Project.md" }, { path: "B/Project.md" }],
      auditProject: vi.fn(async (p: string) => {
        if (p === "A/Project.md") throw new Error("bad yaml");
        return [{ code: "unsupported-claim", severity: "error", path: "B/c.md", explanation: "no support", repair: "" }];
      }) as HealthDeps["auditProject"],
    })).scan();
    const research = report.sections.find((s) => s.id === "research")!;
    expect(research.items).toEqual(expect.arrayContaining([
      { path: "A/Project.md", message: "Could not audit: bad yaml", project: "A/Project.md" },
      { path: "B/c.md", message: "no support", project: "B/Project.md" },
    ]));
  });

  it("passes index state through", async () => {
    const report = await new HealthController(deps({ index: async () => ({ enabled: true, built: true, failed: [{ path: "x.md", message: "boom" }] }) })).scan();
    expect(report.sections.find((s) => s.id === "index")).toMatchObject({ count: 1, severity: "warning" });
  });

  it("passes companion status through", async () => {
    const report = await new HealthController(deps()).scan();
    expect(report.sections.find((s) => s.id === "connection")).toMatchObject({ severity: "error" });
  });

  it("safeFixes lists only keys conform changed", () => {
    const listType: ResolvedType = {
      name: "tagged", version: 1, lineage: ["tagged", "entity"],
      properties: [{ key: "aliases", type: "string[]", required: false }], relations: [],
    };
    const c = new HealthController(deps({
      markdownFiles: () => [{ path: "a.md", frontmatter: { type: "tagged", aliases: "solo", title: "A" } }],
      ontology: () => ({ resolve: () => listType, resolved: () => new Map([["tagged", listType]]) }),
    }));
    expect(c.safeFixes()).toEqual([{ path: "a.md", changes: [{ key: "aliases", from: "solo", to: ["solo"] }], fixed: { type: "tagged", aliases: ["solo"], title: "A" } }]);
  });
});

import { describe, expect, it } from "vitest";
import { HEALTH_ITEM_CAP, scanVaultHealth, type HealthInput } from "../../src/health/scan";

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  typedNotes: [],
  unresolved: {},
  research: [],
  index: { enabled: true, built: true, failed: [] },
  inboxPending: 0,
  companion: { connection: { backend: "claude", needsCredential: false }, activity: [], bridge: { applicable: true, enabled: false, running: false, port: 27124 }, clipper: { applicable: true, status: "current" }, orders: { invalid: [] } },
  now: "2026-10-01T00:00:00.000Z",
  ...over,
});
const section = (input: HealthInput, id: string) => scanVaultHealth(input).sections.find((s) => s.id === id);

describe("scanVaultHealth", () => {
  it("omits ontology when not seeded and index when semantic search is off", () => {
    const ids = scanVaultHealth(base({ typedNotes: null, index: { enabled: false, built: false, failed: [] } })).sections.map((s) => s.id);
    expect(ids).not.toContain("ontology");
    expect(ids).not.toContain("index");
  });

  it("reports ontology issues and fixable notes", () => {
    const s = section(base({ typedNotes: [
      { path: "a.md", issues: [{ kind: "missing-required", key: "status", message: "missing status" }], fixChanges: 1 },
      { path: "b.md", issues: [], fixChanges: 0 },
    ] }), "ontology")!;
    expect(s).toMatchObject({ count: 1, severity: "warning", fixable: 1, items: [{ path: "a.md", message: "missing status" }] });
  });

  it("counts broken link occurrences with one row per source note", () => {
    const s = section(base({ unresolved: { "a.md": { "Missing": 2, "Gone": 1 }, "b.md": {} } }), "links")!;
    expect(s.count).toBe(3);
    expect(s.items).toEqual([{ path: "a.md", message: "3 broken links: Missing, Gone" }]);
  });

  it("caps items at 50 with the uncapped count", () => {
    const unresolved: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 120; i++) unresolved[`n${i}.md`] = { X: 1 };
    const s = section(base({ unresolved }), "links")!;
    expect(s.count).toBe(120);
    expect(s.items).toHaveLength(HEALTH_ITEM_CAP);
  });

  it("counts research errors and warnings, not info, and takes the worst severity", () => {
    const s = section(base({ research: [{ project: "P/Project.md", findings: [
      { severity: "warning", path: "P/e.md", explanation: "unreviewed" },
      { severity: "info", path: "P/u.md", explanation: "unused" },
      { severity: "error", path: "P/c.md", explanation: "unsupported" },
    ] }] }), "research")!;
    expect(s.count).toBe(2);
    expect(s.severity).toBe("error");
    expect(s.items.map((i) => i.path)).toEqual(["P/c.md", "P/e.md"]);
  });

  it("index: not built is info; failures are warnings with one row each", () => {
    expect(section(base({ index: { enabled: true, built: false, failed: [] } }), "index")).toMatchObject({ count: 1, severity: "info", items: [{ path: "", message: "Semantic index not built yet" }] });
    expect(section(base({ index: { enabled: true, built: true, failed: [{ path: "x.md", message: "boom" }] } }), "index")).toMatchObject({ count: 1, severity: "warning", items: [{ path: "x.md", message: "boom" }] });
  });

  it("inbox pending is info", () => {
    expect(section(base({ inboxPending: 4 }), "inbox")).toMatchObject({ count: 4, severity: "info", items: [{ path: "", message: "4 clips waiting to be enriched" }] });
  });

  it("orders sections by severity, then fixed order", () => {
    const ids = scanVaultHealth(base({
      inboxPending: 1,
      unresolved: { "a.md": { X: 1 } },
      research: [{ project: "P", findings: [{ severity: "error", path: "P/c.md", explanation: "x" }] }],
    })).sections.filter((s) => s.group === "vault").map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(["research", "links", "inbox"]);
  });

  const companion = (over: Partial<HealthInput["companion"]>) => base({ companion: { ...base().companion, ...over } });

  it("connection without a credential is an error with the setup action", () => {
    expect(section(companion({ connection: { backend: "claude-cli", needsCredential: true } }), "connection")).toMatchObject({
      group: "companion", count: 1, severity: "error",
      items: [{ path: "", message: "claude-cli has no credential — chat cannot send" }],
      actions: [{ id: "open-setup-wizard", label: "Open setup wizard" }],
    });
  });

  it("activity records become warnings carrying their recovery actions", () => {
    const s = section(companion({ activity: [{ id: "semantic-index:catch-up", title: "Semantic index needs attention", failed: 2, recovery: [{ id: "retry-index", label: "Retry" }] }] }), "activity")!;
    expect(s).toMatchObject({ count: 1, severity: "warning", items: [{ path: "", message: "Semantic index needs attention — 2 failed" }] });
    expect(s.actions).toEqual([{ id: "retry-index", label: "Retry", activityId: "semantic-index:catch-up" }]);
  });

  it("bridge on but not running is an error", () => {
    expect(section(companion({ bridge: { applicable: true, enabled: true, running: false, port: 27124 } }), "bridge")).toMatchObject({
      severity: "error", items: [{ path: "", message: "Bridge is on but not running on port 27124" }],
      actions: [{ id: "open-settings", label: "Open settings · Agent → Agent bridge" }],
    });
  });

  it("omits bridge and clipper when not applicable", () => {
    const ids = scanVaultHealth(companion({ bridge: { applicable: false, enabled: true, running: false, port: 1 }, clipper: { applicable: false, status: "not-set-up" } })).sections.map((s) => s.id);
    expect(ids).not.toContain("bridge");
    expect(ids).not.toContain("clipper");
  });

  it("clipper status maps to severity and action label", () => {
    expect(section(companion({ clipper: { applicable: true, status: "update-available" } }), "clipper")).toMatchObject({ severity: "warning", actions: [{ id: "clipper-schemas", label: "Update schemas" }] });
    expect(section(companion({ clipper: { applicable: true, status: "not-set-up" } }), "clipper")).toMatchObject({ severity: "info", actions: [{ id: "clipper-schemas", label: "Set up Web Clipper" }] });
  });

  it("orders is ok with no invalid orders and a warning listing each invalid one with an open action", () => {
    expect(section(companion({}), "orders")).toMatchObject({ group: "companion", count: 0, severity: "ok", items: [] });
    const invalid = [{ path: "Claude/Templates/Daily.md", reason: 'Unrecognised schedule "hourly" — use "daily 08:00" or "weekly mon 08:00".' }];
    expect(section(companion({ orders: { invalid } }), "orders")).toMatchObject({
      count: 1,
      severity: "warning",
      items: [{ path: "Claude/Templates/Daily.md", message: 'Claude/Templates/Daily.md — Unrecognised schedule "hourly" — use "daily 08:00" or "weekly mon 08:00".' }],
      actions: [{ id: "open-note", label: "Open Daily", path: "Claude/Templates/Daily.md" }],
    });
  });

  it("index belongs to the companion group; companion sections come first", () => {
    const report = scanVaultHealth(base({ unresolved: { "a.md": { X: 1 } }, index: { enabled: true, built: false, failed: [] } }));
    expect(report.sections.find((s) => s.id === "index")?.group).toBe("companion");
    const groups = report.sections.map((s) => s.group);
    expect(groups.indexOf("vault")).toBeGreaterThan(groups.lastIndexOf("companion"));
  });
});

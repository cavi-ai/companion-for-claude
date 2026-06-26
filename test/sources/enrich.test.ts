import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { enrichCapture } from "../../src/sources/enrich";
import type { EnrichDeps } from "../../src/sources/enrich";

const LEAK = "sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF";

function deps(app: App, complete: EnrichDeps["complete"]): EnrichDeps {
  return { app, complete, baseTags: ["source"], enrichedBy: "claude", now: () => "2026-06-16T00:00:00Z" };
}

describe("enrichCapture — markdown clip", () => {
  it("types the note in place, sanitizes fields, preserves the body", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/a.md", "---\nsource: https://stratechery.com/p\n---\n\nArticle body.");
    const complete = async () => JSON.stringify({ title: "T", site: "Stratechery", summary: `Sum ${LEAK}` });
    const res = await enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/a.md", basename: "a", content: (file as TFile)._content });
    expect(res.type).toBe("article");
    const out = await app.vault.cachedRead(res.file);
    expect(out).toContain("type: article");
    expect(out).toContain("source_enriched: true");
    expect(out).not.toContain(LEAK);
    expect(out).toContain("‹REDACTED›");
    expect(out).toContain("Article body.");
  });
});

describe("enrichCapture — dropped CSV", () => {
  it("creates a sidecar note with derived columns/rows and an embed", async () => {
    const app = new App();
    const complete = async () => JSON.stringify({ title: "Sales", summary: "Monthly sales." });
    const res = await enrichCapture(deps(app, complete), { kind: "datafile", path: "Clippings/sales.csv", basename: "sales", ext: "csv", content: "date,units\n2024,10\n2025,20" });
    expect(res.type).toBe("dataset");
    expect(res.record.fields.columns).toEqual(["date", "units"]);
    expect(res.record.fields.rows).toBe(2);
    const out = await app.vault.cachedRead(res.file);
    expect(out).toContain("![[sales.csv]]");
    expect(out).toContain("asset: Clippings/sales.csv");
  });
});

describe("enrichCapture — extraction failure", () => {
  it("propagates the error and leaves the markdown note untouched", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/x.md", "---\nsource: https://x.com/p\n---\n\nUntouched body.");
    const complete = async () => "not json at all";
    await expect(
      enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/x.md", basename: "x", content: (file as TFile)._content }),
    ).rejects.toThrow();
    const out = await app.vault.cachedRead(file as TFile);
    expect(out).not.toContain("source_enriched");
    expect(out).toContain("Untouched body.");
  });
});

describe("enrichCapture — re-enriching a CSV", () => {
  it("modifies the existing sidecar instead of creating a duplicate", async () => {
    const app = new App();
    const complete = async () => JSON.stringify({ title: "Sales", summary: "Monthly sales." });
    const cap = { kind: "datafile" as const, path: "Clippings/sales.csv", basename: "sales", ext: "csv", content: "date,units\n2024,10" };
    const r1 = await enrichCapture(deps(app, complete), cap);
    const r2 = await enrichCapture(deps(app, complete), cap);
    expect(r2.file.path).toBe(r1.file.path);
    const sidecars = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Clippings/") && f.path.endsWith(".md"));
    expect(sidecars).toHaveLength(1);
  });
});

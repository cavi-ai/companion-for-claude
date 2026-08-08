import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { enrichCapture } from "../../src/sources/enrich";
import type { EnrichDeps } from "../../src/sources/enrich";
import { EnrichmentQualityError, markdownBody } from "../../src/sources/enrichmentQuality";
import { parse as parseYaml } from "yaml";

const LEAK = "sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF";

function deps(app: App, complete: EnrichDeps["complete"]): EnrichDeps {
  return { app, complete, baseTags: ["source"], enrichedBy: "claude", now: () => "2026-06-16T00:00:00Z" };
}

describe("enrichCapture — markdown clip", () => {
  it("preserves newer user frontmatter written while extraction is in flight", async () => {
    const app = new App();
    const initial = [
      "---",
      "title: Initial title",
      "site: Example",
      "tags:",
      "  - initial",
      "---",
      "",
      "Body.",
    ].join("\n");
    const file = app.vault.seed("Clippings/concurrent.md", initial);
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    let finishExtraction!: (reply: string) => void;
    const completion = new Promise<string>((resolve) => { finishExtraction = resolve; });
    const complete = async () => {
      extractionStarted();
      return completion;
    };

    const pending = enrichCapture(deps(app, complete), {
      kind: "markdown",
      path: "Clippings/concurrent.md",
      basename: "concurrent",
      content: initial,
    });
    await started;
    await app.vault.modify(file as TFile, [
      "---",
      "title: User title",
      "site: Example",
      "summary: User summary",
      "tags:",
      "  - '#Source'",
      "  - Research Notes",
      "---",
      "",
      "Body.",
    ].join("\n"));
    finishExtraction(JSON.stringify({ summary: "Model summary", topics: ["model-topic"] }));

    const result = await pending;
    const out = await app.vault.cachedRead(result.file);
    const frontmatter = parseYaml(/^---\n([\s\S]*?)\n---/.exec(out)?.[1] ?? "");
    expect(frontmatter.title).toBe("User title");
    expect(frontmatter.summary).toBe("User summary");
    expect(frontmatter.tags).toEqual(["source", "research-notes", "model-topic"]);
    expect(markdownBody(out)).toBe("\nBody.");
  });

  it("changes frontmatter while preserving every body byte", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/a.md", "---\nsource: https://stratechery.com/p\n---\n\n# Article body\n\nLine with two spaces.  \n---\nFinal line.\n");
    const complete = async () => JSON.stringify({ title: "A useful title", site: "Stratechery", summary: "A concise summary." });
    const res = await enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/a.md", basename: "a", content: (file as TFile)._content });
    expect(res.type).toBe("article");
    const out = await app.vault.cachedRead(res.file);
    expect(parseYaml(/^---\n([\s\S]*?)\n---/.exec(out)?.[1] ?? "").type).toBe("article");
    expect(out).toContain("source_enriched: true");
    expect(markdownBody(out)).toBe("\n# Article body\n\nLine with two spaces.  \n---\nFinal line.\n");
  });

  it("enriches CRLF Markdown through the atomic write path without changing a body byte", async () => {
    const app = new App();
    const before = "---\r\ntitle: CRLF capture\r\nsite: Example\r\n---\r\n\r\n# Body\r\n\r\nTrailing spaces.  \r\n";
    const file = app.vault.seed("Clippings/crlf.md", before);
    const complete = async () => JSON.stringify({ summary: "A concise summary." });

    const res = await enrichCapture(deps(app, complete), {
      kind: "markdown",
      path: "Clippings/crlf.md",
      basename: "crlf",
      content: before,
    });

    const out = await app.vault.cachedRead(res.file);
    expect(out).toContain("\r\n---\r\n\r\n# Body");
    expect(markdownBody(out)).toBe("\r\n# Body\r\n\r\nTrailing spaces.  \r\n");
  });

  it("adds frontmatter to a plain Markdown capture without adding or removing a body byte", async () => {
    const app = new App();
    const before = "# Plain capture\n\nBody with trailing spaces.  \n";
    const file = app.vault.seed("Clippings/plain.md", before);
    const complete = async () => JSON.stringify({ title: "A plain capture", site: "Example", summary: "A concise summary." });

    const res = await enrichCapture(deps(app, complete), {
      kind: "markdown",
      path: "Clippings/plain.md",
      basename: "plain",
      content: (file as TFile)._content,
    });

    const out = await app.vault.cachedRead(res.file);
    expect(out).toContain("source_enriched: true");
    expect(markdownBody(out)).toBe(before);
  });

  it("rejects secret-bearing URL provenance before touching the note", async () => {
    const app = new App();
    const before = "---\nsource: https://example.com/\n---\n\nUntouched.\n";
    const file = app.vault.seed("Clippings/provenance.md", before);
    const complete = async () => JSON.stringify({ title: "Credential safety", site: "Example", summary: "A concise summary." });

    await expect(enrichCapture(deps(app, complete), {
      kind: "markdown",
      path: "Clippings/provenance.md",
      basename: "provenance",
      content: before,
      url: "https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    })).rejects.toThrow("provenance.url: contains secret-bearing content");

    expect(await app.vault.cachedRead(file as TFile)).toBe(before);
  });

  it("unions existing, base, and normalized topic tags without duplicates", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/tags.md", "---\ntags:\n  - web-clip\n  - source\nsource: https://example.com/post\n---\n\nBody.\n");
    const complete = async () => JSON.stringify({
      title: "Tag union behavior",
      site: "Example",
      summary: "A concise summary.",
      topics: ["Research Notes", "source", "research-notes"],
    });
    const withOverlappingBase = { ...deps(app, complete), baseTags: ["source", "inbox", "web-clip"] };

    const res = await enrichCapture(withOverlappingBase, {
      kind: "markdown",
      path: "Clippings/tags.md",
      basename: "tags",
      content: (file as TFile)._content,
    });

    const out = await app.vault.cachedRead(res.file);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(out)?.[1];
    expect(parseYaml(frontmatter ?? "").tags).toEqual(["web-clip", "source", "inbox", "research-notes"]);
  });

  it("keeps clipper-stamped values and only asks the model for the rest", async () => {
    const app = new App();
    const clipped = [
      "---",
      "type: article",
      "title: Clipped Title",
      "author: Jane Doe",
      "site: Example",
      "published: 2026-07-01",
      "source: https://example.com/post",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const file = app.vault.seed("Clippings/b.md", clipped);
    let system = "";
    const complete = async (sys: string) => {
      system = sys;
      return JSON.stringify({ summary: "A one-liner." });
    };
    const res = await enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/b.md", basename: "b", content: (file as TFile)._content });
    // The model was never asked for the page-known fields…
    expect(system).not.toContain("- title (");
    expect(system).not.toContain("- author (");
    expect(system).not.toContain("- site (");
    // …and the clipper's values survive into the enriched note.
    const out = await app.vault.cachedRead(res.file);
    expect(out).toContain("Clipped Title");
    expect(out).toContain("Jane Doe");
    expect(out).toContain("A one-liner.");
    expect(out).toContain("source_enriched: true");
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
    expect(out).toContain('asset: "Clippings/sales.csv"');
  });
});

describe("enrichCapture — extraction failure", () => {
  it.each([
    {
      name: "placeholder title",
      liveFrontmatter: ["title: Untitled", "site: Example", "summary: User summary"],
      message: "title: must be a meaningful, non-placeholder title",
    },
    {
      name: "overlong summary",
      liveFrontmatter: ["title: User title", "site: Example", `summary: ${"s".repeat(201)}`],
      message: "summary: must be at most 200 characters",
    },
    {
      name: "wrong schema field type",
      liveFrontmatter: ["title: User title", "site: 42", "summary: User summary"],
      message: "fields.site: expected string",
    },
    {
      name: "secret-bearing URL",
      liveFrontmatter: [
        "title: User title",
        "site: Example",
        "summary: User summary",
        "url: https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz0123",
      ],
      message: "provenance.url: contains secret-bearing content",
    },
    {
      name: "secret-bearing source URL alias",
      liveFrontmatter: [
        "title: User title",
        "site: Example",
        "summary: User summary",
        "source: https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz0123",
      ],
      message: "provenance.source: contains secret-bearing content",
    },
    {
      name: "numeric URL",
      liveFrontmatter: ["title: User title", "site: Example", "summary: User summary", "url: 42"],
      message: "provenance.url: expected string",
    },
    {
      name: "array URL",
      liveFrontmatter: ["title: User title", "site: Example", "summary: User summary", "url:", "  - https://example.com/"],
      message: "provenance.url: expected string",
    },
    {
      name: "object URL with a nested secret",
      liveFrontmatter: [
        "title: User title",
        "site: Example",
        "summary: User summary",
        "url:",
        "  auth:",
        `    token: ${LEAK}`,
      ],
      message: "provenance.url: contains secret-bearing content",
    },
    {
      name: "array source URL alias with a nested secret",
      liveFrontmatter: [
        "title: User title",
        "site: Example",
        "summary: User summary",
        "source:",
        "  - href: https://example.com/",
        `  - token: ${LEAK}`,
      ],
      message: "provenance.source: contains secret-bearing content",
    },
    {
      name: "object source URL alias",
      liveFrontmatter: [
        "title: User title",
        "site: Example",
        "summary: User summary",
        "source:",
        "  href: https://example.com/",
      ],
      message: "provenance.source: expected string",
    },
    {
      name: "array asset provenance",
      capturedFrontmatter: ["type: video", "title: Initial title", "channel: Example"],
      liveFrontmatter: [
        "type: video",
        "title: User title",
        "channel: Example",
        "summary: User summary",
        "asset:",
        "  - Clippings/video.mp4",
      ],
      message: "provenance.assetPath: expected string",
    },
  ])("rejects a concurrent live $name without writing any enrichment", async ({ capturedFrontmatter, liveFrontmatter, message }) => {
    const app = new App();
    const captured = [
      "---",
      ...(capturedFrontmatter ?? ["title: Initial title", "site: Example"]),
      "---",
      "",
      "Body.",
    ].join("\n");
    const file = app.vault.seed("Clippings/live-invalid.md", captured);
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    let finishExtraction!: (reply: string) => void;
    const completion = new Promise<string>((resolve) => { finishExtraction = resolve; });
    const complete = async () => {
      extractionStarted();
      return completion;
    };

    const pending = enrichCapture(deps(app, complete), {
      kind: "markdown",
      path: "Clippings/live-invalid.md",
      basename: "live-invalid",
      content: captured,
    });
    await started;
    const live = ["---", ...liveFrontmatter, "---", "", "Body."].join("\n");
    await app.vault.modify(file as TFile, live);
    const rejected = expect(pending).rejects.toThrow(message);
    finishExtraction(JSON.stringify({ summary: "Model summary" }));

    await rejected;
    const after = await app.vault.cachedRead(file as TFile);
    expect(after).toBe(live);
    expect(after).not.toContain("source_enriched");
  });

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

  it("rejects secret-bearing enrichment before mutation and leaves the complete note byte-identical", async () => {
    const app = new App();
    const before = "---\nsource: https://x.com/p\ntags:\n  - private\n---\n\nUntouched body.  \n";
    const file = app.vault.seed("Clippings/secret.md", before);
    const complete = async () => JSON.stringify({ title: "A safe title", site: "Example", summary: `Summary ${LEAK}` });

    await expect(
      enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/secret.md", basename: "secret", content: (file as TFile)._content }),
    ).rejects.toBeInstanceOf(EnrichmentQualityError);

    expect(await app.vault.cachedRead(file as TFile)).toBe(before);
  });

  it("leaves the complete note unchanged when the atomic pure merge rejects current YAML", async () => {
    const app = new App();
    const captured = "---\ntitle: Captured title\nsite: Example\n---\n\nOriginal body.  \n";
    const file = app.vault.seed("Clippings/atomic.md", captured);
    const complete = async () => JSON.stringify({ summary: "A concise summary." });
    const before = "---\ntitle: [invalid yaml\nsite: Example\n---\n\nOriginal body.  \n";
    await app.vault.modify(file as TFile, before);

    await expect(
      enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/atomic.md", basename: "atomic", content: captured }),
    ).rejects.toThrow();

    expect(await app.vault.cachedRead(file as TFile)).toBe(before);
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

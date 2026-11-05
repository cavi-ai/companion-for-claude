import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import { ClipPageError, enrichCapture } from "../../src/sources/enrich";
import type { EnrichDeps } from "../../src/sources/enrich";
import { markdownBody } from "../../src/sources/enrichmentQuality";
import { parse as parseYaml } from "yaml";

const LEAK = "sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF";

function deps(app: App, complete: EnrichDeps["complete"]): EnrichDeps {
  return { app, complete, baseTags: ["source"], enrichedBy: "claude", now: () => "2026-06-16T00:00:00Z" };
}

describe("enrichCapture — markdown clip", () => {
  it.each(["title: [broken", "- list item"])("rejects invalid properties before requesting extraction: %s", async (yaml) => {
    const app = new App();
    const before = `---\n${yaml}\n---\n\nBody.  \n`;
    const file = app.vault.seed("Clippings/invalid.md", before, { frontmatter: { title: "Stale cached title" } });
    const complete = vi.fn(async () => JSON.stringify({ title: "Title", site: "Example", summary: "Summary" }));

    await expect(enrichCapture(deps(app, complete), {
      kind: "markdown", path: file.path, basename: "invalid", content: before,
    })).rejects.toThrow("Open the note and fix its opening YAML properties block, then retry.");

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file as TFile)).toBe(before);
  });

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
    app.vault.seed("Clippings/crlf.md", before);
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

  it("masks secret-shaped text in enriched fields instead of rejecting the clip", async () => {
    const app = new App();
    const before = "---\nsource: https://x.com/p\ntags:\n  - private\n---\n\nUntouched body.  \n";
    const file = app.vault.seed("Clippings/secret.md", before);
    const complete = async () => JSON.stringify({ title: "A safe title", site: "Example", summary: `Summary ${LEAK}` });

    await enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/secret.md", basename: "secret", content: (file as TFile)._content });

    const out = await app.vault.cachedRead(file as TFile);
    expect(out).toContain("source_enriched: true");
    expect(out).toContain("Summary ‹REDACTED›");
    expect(out).not.toContain(LEAK);
    expect(out).toContain("Untouched body.");
  });

  it("enriches a security-tool repo clip whose summary quotes example keys and env vars", async () => {
    const app = new App();
    const before = "---\nsource: https://github.com/gitleaks/gitleaks\n---\n\nGitleaks scans git repos for hardcoded secrets.\n";
    const file = app.vault.seed("Clippings/gitleaks.md", before);
    const complete = async () => JSON.stringify({
      title: "Gitleaks",
      site: "GitHub",
      summary: "Detects hardcoded secrets such as AWS keys (AKIAIOSFODNN7EXAMPLE); set GITHUB_TOKEN: environment variable for private repos.",
    });

    await enrichCapture(deps(app, complete), { kind: "markdown", path: "Clippings/gitleaks.md", basename: "gitleaks", content: (file as TFile)._content });

    const out = await app.vault.cachedRead(file as TFile);
    expect(out).toContain("source_enriched: true");
    expect(out).toContain("GITHUB_TOKEN: environment variable");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
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

describe("enrichCapture — sidecar ownership", () => {
  const capture = { kind: "datafile" as const, path: "Clippings/sales.csv", basename: "sales", ext: "csv", content: "date,units\n2024,10" };
  const complete = async () => JSON.stringify({ title: "Sales", summary: "Monthly sales." });

  it("preserves an unrelated note whose name matches the generated title", async () => {
    const app = new App();
    const original = "# Sales\n\nUser-owned notes.\n";
    const existing = app.vault.seed("Clippings/Sales.md", original);
    const result = await enrichCapture(deps(app, complete), capture);
    expect(await app.vault.read(existing)).toBe(original);
    expect(result.file.path).not.toBe(existing.path);
  });

  it("keeps the sidecar identity, body and custom metadata across title changes", async () => {
    const app = new App();
    const first = await enrichCapture(deps(app, complete), capture);
    const annotated = (await app.vault.read(first.file)).replace("source_enriched:", "reviewer: Franco\nsource_enriched:") + "\nUSER ANNOTATION\n";
    await app.vault.modify(first.file, annotated);
    const second = await enrichCapture(deps(app, async () => JSON.stringify({ title: "Updated sales", summary: "Updated summary." })), { ...capture, content: "date,units\n2024,10\n2025,20" });
    expect(second.file.path).toBe(first.file.path);
    expect(markdownBody(await app.vault.read(second.file))).toBe(markdownBody(annotated));
    expect(parseYaml((await app.vault.read(second.file)).split("---")[1]!)).toMatchObject({ reviewer: "Franco", title: "Sales", rows: 2 });
  });

  it("preserves edits made at the atomic update boundary", async () => {
    const app = new App();
    const first = await enrichCapture(deps(app, complete), capture);
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, "process").mockImplementation(async (file, transform) => {
      await app.vault.modify(file, (await app.vault.read(file)) + "\nConcurrent annotation.\n");
      return process(file, transform);
    });
    await enrichCapture(deps(app, complete), capture);
    expect(await app.vault.read(first.file)).toContain("Concurrent annotation.");
  });

  it("refuses an update when the current sidecar ownership changes", async () => {
    const app = new App();
    const first = await enrichCapture(deps(app, complete), capture);
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, "process").mockImplementation(async (file, transform) => {
      await app.vault.modify(file, "# Replaced with user-owned content\n");
      return process(file, transform);
    });
    await expect(enrichCapture(deps(app, complete), capture)).rejects.toThrow(/ownership|belongs|changed/);
    expect(await app.vault.read(first.file)).toBe("# Replaced with user-owned content\n");
  });
});

describe("enrichCapture — clip that arrived empty", () => {
  const EMPTY = "---\ntitle: Run it locally\nsource: https://www.reddit.com/r/unsloth/s/3rCTTgaPdB\n---\n";
  const PAGE = "The post explains how to run the model on one GPU.\n\n## Comments\n\nA reply about quantization.";
  const reply = JSON.stringify({ site: "Reddit", summary: "Running the model on one GPU." });

  it("reads the source page, enriches from it, and fills the body", async () => {
    const app = new App();
    app.vault.seed("Clippings/empty.md", EMPTY);
    const captureWeb = vi.fn(async () => ({ markdown: PAGE }));
    const complete = vi.fn(async () => reply);

    const res = await enrichCapture({ ...deps(app, complete), captureWeb }, { kind: "markdown", path: "Clippings/empty.md", basename: "empty", content: EMPTY });

    expect(captureWeb).toHaveBeenCalledWith("https://www.reddit.com/r/unsloth/s/3rCTTgaPdB");
    expect(complete.mock.calls[0]?.[1]).toContain("run the model on one GPU");
    expect(res.readFromPage).toBe(true);
    const out = await app.vault.cachedRead(res.file);
    expect(markdownBody(out)).toBe(`${PAGE}\n`);
    expect(out).toContain("source_enriched: true");
    expect(out).toContain("summary: Running the model on one GPU.");
  });

  it("recovers a clip whose blank source property accompanies a valid url", async () => {
    const app = new App();
    const before = '---\ntitle: Run it locally\nsource: " "\nurl: https://example.com/post\n---\n';
    const file = app.vault.seed("Clippings/blank-source.md", before);
    const captureWeb = async (url: string) => {
      expect(url).toBe("https://example.com/post");
      return { markdown: PAGE };
    };
    const res = await enrichCapture({ ...deps(app, async () => reply), captureWeb }, {
      kind: "markdown", path: file.path, basename: file.basename, content: before,
    });
    expect(res.readFromPage).toBe(true);
    expect(markdownBody(await app.vault.read(res.file))).toBe(`${PAGE}\n`);
    expect(res.record.provenance.url).toBe("https://example.com/post");
  });

  it("recovers from an explicit capture URL when the note has no URL property", async () => {
    const app = new App();
    const before = "---\ntitle: Run it locally\n---\n";
    const file = app.vault.seed("Clippings/explicit-url.md", before);
    const res = await enrichCapture({ ...deps(app, async () => reply), captureWeb: async () => ({ markdown: PAGE }) }, {
      kind: "markdown", path: file.path, basename: file.basename, content: before, url: "https://example.com/post",
    });
    expect(markdownBody(await app.vault.read(res.file))).toBe(`${PAGE}\n`);
    expect(res.record.provenance.url).toBe("https://example.com/post");
  });

  it.each([
    ["source", "page"], ["url", "page"], ["source", "model"], ["url", "model"],
  ])("keeps a changed %s URL untouched when it changes during the %s request", async (key, phase) => {
    const app = new App();
    const before = `---\ntitle: Run it locally\n${key}: https://example.com/old\n---\n`;
    const changed = before.replace("https://example.com/old", "https://example.com/new");
    const file = app.vault.seed("Clippings/changed-source.md", before);
    const captureWeb = async () => {
      if (phase === "page") await app.vault.modify(file as TFile, changed);
      return { markdown: PAGE };
    };
    const complete = async () => {
      if (phase === "model") await app.vault.modify(file as TFile, changed);
      return reply;
    };
    const pending = enrichCapture({ ...deps(app, complete), captureWeb }, {
      kind: "markdown", path: file.path, basename: file.basename, content: before,
    });
    await expect(pending).rejects.toBeInstanceOf(ClipPageError);
    await expect(pending).rejects.toThrow("source URL changed");
    expect(await app.vault.read(file as TFile)).toBe(changed);
  });

  it("leaves a clip that has a body to the clip", async () => {
    const app = new App();
    const withBody = `${EMPTY}\nClipped text.\n`;
    app.vault.seed("Clippings/full.md", withBody);
    const captureWeb = vi.fn(async () => ({ markdown: PAGE }));

    const res = await enrichCapture({ ...deps(app, async () => reply), captureWeb }, { kind: "markdown", path: "Clippings/full.md", basename: "full", content: withBody });

    expect(captureWeb).not.toHaveBeenCalled();
    expect(res.readFromPage).toBe(false);
    expect(markdownBody(await app.vault.cachedRead(res.file))).toBe("\nClipped text.\n");
  });

  it("keeps text written into the note while the page was being read", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/typed.md", EMPTY);
    const captureWeb = vi.fn(async () => {
      await app.vault.modify(file as TFile, `${EMPTY}\nMy own notes.\n`);
      return { markdown: PAGE };
    });

    const res = await enrichCapture({ ...deps(app, async () => reply), captureWeb }, { kind: "markdown", path: "Clippings/typed.md", basename: "typed", content: EMPTY });

    expect(markdownBody(await app.vault.cachedRead(res.file))).toBe("\nMy own notes.\n");
  });

  it.each([undefined, { markdown: "" }, { markdown: "  \n" }])("leaves an empty clip retryable when its page has nothing readable: %j", async (page) => {
    const app = new App();
    const file = app.vault.seed("Clippings/blank.md", EMPTY);
    const complete = vi.fn(async () => reply);

    const pending = enrichCapture({ ...deps(app, complete), captureWeb: async () => page }, { kind: "markdown", path: "Clippings/blank.md", basename: "blank", content: EMPTY });

    await expect(pending).rejects.toBeInstanceOf(ClipPageError);
    await expect(pending).rejects.toThrow("no readable content");
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file as TFile)).toBe(EMPTY);
  });

  it("names the page when it cannot be read and leaves the note for a retry", async () => {
    const app = new App();
    app.vault.seed("Clippings/blocked.md", EMPTY);
    const complete = vi.fn(async () => reply);
    const captureWeb = async () => { throw new Error("Fetch failed with status 403"); };

    const pending = enrichCapture({ ...deps(app, complete), captureWeb }, { kind: "markdown", path: "Clippings/blocked.md", basename: "blocked", content: EMPTY });

    await expect(pending).rejects.toBeInstanceOf(ClipPageError);
    await expect(pending).rejects.toThrow("its page at www.reddit.com could not be read (Fetch failed with status 403)");
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(app.vault.getAbstractFileByPath("Clippings/blocked.md") as TFile)).toBe(EMPTY);
  });
});

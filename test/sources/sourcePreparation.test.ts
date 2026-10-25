import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { mergeSourceMarkdown, sourceProperties } from "../../src/sources/frontmatterMerge";
import { enrichCapture } from "../../src/sources/enrich";
import { detectType, parseClipUrl } from "../../src/sources/detect";
import { stripFrontmatter } from "../../src/markdown/frontmatter";

const article = "---\n\n## Introduction\n\nA study compares several sources of evidence.\n\nThe task: evaluate their findings.\n\n---\n\n## Methods\n\nKeep this section too.  \n";

describe("source input preparation", () => {
  it("preserves an article beginning with a thematic break through an atomic enrichment", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/article.md", article);
    const complete = vi.fn(async (_system: string, user: string) => {
      expect(user).toContain("## Introduction");
      expect(user).toContain("## Methods");
      return JSON.stringify({ title: "Evidence study", site: "Example", summary: "A study of evidence." });
    });
    await enrichCapture({ app, complete, baseTags: [], enrichedBy: "claude", now: () => "2026-10-25" }, {
      kind: "markdown", path: file.path, basename: file.basename, content: article,
    });
    const out = await app.vault.read(file);
    expect(stripFrontmatter(out)).toBe(article);
    expect(sourceProperties(out)).toMatchObject({ title: "Evidence study", source_enriched: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(mergeSourceMarkdown(out, { source_enriched: true })).toBe(out);
  });

  it.each(["\n", "\r\n"])("repairs a stray opening separator without a later separator using %j", (eol) => {
    const body = ["---", "", "# A heading", "", "A paragraph describing the evidence.", ""].join(eol);
    const out = mergeSourceMarkdown(body, { summary: "A summary" });
    expect(stripFrontmatter(out)).toBe(body);
  });

  it.each(["\n", "\r\n"])("quotes an unambiguous malformed field and keeps comments using %j", (eol) => {
    const before = "---\n# Keep this comment\ntitle: Evidence: a study\ncustom: keep\ntags:\n\t- research\n---\n\nBody.  \n".replaceAll("\n", eol);
    const out = mergeSourceMarkdown(before, { summary: "A summary", tags: ["source"] });
    expect(sourceProperties(out)).toMatchObject({ title: "Evidence: a study", custom: "keep", tags: ["research", "source"] });
    expect(out).toContain("# Keep this comment");
    expect(stripFrontmatter(out)).toBe(`${eol}Body.  ${eol}`);
  });

  it("retains nested literal content and quoted keys while updating tags and their comments", () => {
    const before = "---\ntitle: Existing\ncustom: |\n  title: keep this literal\n\"custom key\": keep\ntags: [research] # Keep tag guidance\n---\nBody";
    const out = mergeSourceMarkdown(before, { tags: ["source"], source_enriched: true });
    expect(sourceProperties(out)).toMatchObject({ custom: "title: keep this literal\n", "custom key": "keep", tags: ["research", "source"] });
    expect(out).toContain("# Keep tag guidance");
    expect(stripFrontmatter(out)).toBe("Body");
  });

  it("keeps user alias values valid when a system property replaces their anchor", () => {
    const before = "---\nschema_version: &version 1 # Keep version guidance\ncustom: *version\n---\nBody";
    const out = mergeSourceMarkdown(before, { schema_version: 2 });
    expect(sourceProperties(out)).toMatchObject({ schema_version: 2, custom: 1 });
    expect(out).toContain("# Keep version guidance");
    expect(stripFrontmatter(out)).toBe("Body");
  });

  it("recognizes BOM frontmatter without embedding a second header in the body", () => {
    const out = mergeSourceMarkdown("\uFEFF---\ntitle: Existing\n---\n\nBody", { summary: "A summary" });
    expect(sourceProperties(out)).toMatchObject({ title: "Existing", summary: "A summary" });
    expect(stripFrontmatter(out)).toBe("\nBody");
  });

  it("retains valid commented properties instead of treating the comment as an article heading", () => {
    const out = mergeSourceMarkdown("---\n## Metadata\n\ntitle: Existing\n# Nested comments stay too\ncustom:\n  # A custom field\n  value: keep\n---\n\nBody", { summary: "A summary" });
    expect(sourceProperties(out)).toMatchObject({ title: "Existing", custom: { value: "keep" } });
    expect(out).toContain("# A custom field");
    expect(stripFrontmatter(out)).toBe("\nBody");
  });

  it.each([
    ['"custom key": keep', { "custom key": "keep" }],
    ["标题: 保留", { 标题: "保留" }],
    ["custom.key: keep", { "custom.key": "keep" }],
    ["custom key: keep", { "custom key": "keep" }],
  ])("preserves valid commented properties beginning with %s", (field, expected) => {
    const out = mergeSourceMarkdown(`---\n## Metadata\n\n${field}\n---\n\nBody`, { summary: "A summary" });
    expect(sourceProperties(out)).toMatchObject(expected);
    expect(stripFrontmatter(out)).toBe("\nBody");
  });

  it.each([
    "---\ntitle: [broken\n---\n\nBody",
    "---\ntitle: First\ntitle: Second\n---\n\nBody",
    "---\ntitle: Existing\n\n# Body without a closing fence",
    "---\n## Metadata\n\ncustom key: [broken\n---\n\nBody",
  ])("rejects ambiguous YAML before extraction and leaves the note unchanged", async (before) => {
    const app = new App();
    const file = app.vault.seed("Clippings/invalid.md", before);
    const complete = vi.fn(async () => "{}");
    await expect(enrichCapture({ app, complete, baseTags: [], enrichedBy: "claude", now: () => "2026-10-25" }, {
      kind: "markdown", path: file.path, basename: file.basename, content: before,
    })).rejects.toThrow(/YAML/);
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.read(file)).toBe(before);
  });

  it("uses actual YAML properties rather than stamps in a body example", () => {
    const content = "# An article\n\n```yaml\ntype: video\nsource: https://youtu.be/example\n```";
    expect(detectType({ kind: "markdown", path: "a.md", basename: "a", content })).toBe("article");
    expect(parseClipUrl(content)).toBeUndefined();
  });
});

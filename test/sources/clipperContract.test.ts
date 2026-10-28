import { describe, expect, it } from "vitest";
import { clipperTemplateFor, serializeClipperTemplate } from "../../src/sources/clipperTemplate";
import { clipperSetupFor } from "../../src/sources/clipperSetup";
import { getSchema } from "../../src/sources/registry";

const schemas = () => (["article", "video", "dataset"] as const).map((type) => getSchema(type));

// Web Clipper treats /.../ as regex and every other trigger as a literal URL prefix.
const matches = (pattern: string, url: string) => pattern.startsWith("/") && pattern.endsWith("/")
  ? new RegExp(pattern.slice(1, -1)).test(url) : url.startsWith(pattern);

describe("Web Clipper export contract", () => {
  it.each(["article", "video", "dataset"] as const)("exports %s property types separately from a clipping template", (type) => {
    const setup = clipperSetupFor(type, schemas(), { inboxFolder: "Clippings", baseTags: ["source"], savedFingerprint: "" });
    expect(setup.propertyTypesFile).toMatchObject({ fileName: `companion-${type}-properties.json`, mimeType: "application/json" });
    const properties = JSON.parse(setup.propertyTypesFile.json);
    expect(properties).toMatchObject({ types: { type: "text", source: "text", schema_version: "number", title: "text", clipped: "date", tags: "multitext", clipper_template: "text" } });
    expect(properties).not.toHaveProperty("properties");
    expect(properties).not.toHaveProperty("noteContentFormat");
    expect(JSON.parse(setup.json)).not.toHaveProperty("types");
  });

  it.each([
    ["https://www.youtube.com/watch?v=one", true],
    ["https://youtube.com/watch?v=one", true],
    ["https://youtu.be/one", true],
    ["https://www.youtube.com/shorts/one", true],
    ["https://example.com/watch?v=one", false],
    ["https://youtube.com.evil.test/watch?v=one", false],
  ])("selects the video template for %s: %s", (url, wanted) => {
    const template = clipperTemplateFor(getSchema("video"), { path: "Clippings", tags: [] });
    expect(template.triggers?.some((pattern) => matches(pattern, url))).toBe(wanted);
  });

  it("provides a file name and content type alongside the same JSON used by copy", () => {
    const setup = clipperSetupFor("article", schemas(), { inboxFolder: "Clippings", baseTags: [], savedFingerprint: "" });
    expect(setup).toMatchObject({ fileName: "companion-article-clipper.json", mimeType: "application/json" });
    const payload = JSON.parse(setup.json);
    expect(payload.properties.find((property: { name: string }) => property.name === "clipper_template")?.value).toBeTruthy();
  });

  it("explains JSON text import and keeps dataset selection separate from the article fallback", () => {
    const options = { inboxFolder: "Clippings", baseTags: [], savedFingerprint: "" };
    const article = clipperSetupFor("article", schemas(), options);
    const dataset = clipperSetupFor("dataset", schemas(), options);
    expect(article.instructions).toMatch(/Import.*JSON.*paste/i);
    expect(article.instructions).toContain("top of the template list");
    expect(dataset.instructions).toMatch(/select.*Companion: dataset/i);
    expect(dataset.instructions).not.toContain("top of the template list");
  });

  it("rejects duplicate property names instead of exporting a template with ambiguous metadata", () => {
    const template = clipperTemplateFor(getSchema("article"), { path: "Clippings", tags: [] });
    template.properties.push({ name: "type", type: "text", value: "video" });
    expect(() => serializeClipperTemplate(template)).toThrow(/duplicate/i);
  });
});

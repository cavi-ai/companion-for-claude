import { describe, it, expect } from "vitest";
import { clipperTemplateFor, clipperTemplateFileName, serializeClipperTemplate } from "../../src/sources/clipperTemplate";
import { getSchema } from "../../src/sources/registry";

const OPTS = { path: "Clippings", tags: ["source"] };

describe("clipperTemplateFor", () => {
  it("stamps a literal type and the clip URL so clips land pre-typed", () => {
    const t = clipperTemplateFor(getSchema("article"), OPTS);
    const props = Object.fromEntries(t.properties.map((p) => [p.name, p]));
    expect(props.type).toMatchObject({ value: "article", type: "text" });
    expect(props.source).toMatchObject({ value: "{{url}}", type: "text" });
    expect(props.tags).toMatchObject({ value: "source", type: "multitext" });
  });

  it("maps page-known schema fields to clipper variables and skips model-only ones", () => {
    const t = clipperTemplateFor(getSchema("article"), OPTS);
    const names = t.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["title", "author", "site", "published", "clipped"]));
    // Model-synthesized fields must NOT be in the template — the clipper can't know them.
    for (const absent of ["summary", "topics", "key_claims", "reading_time", "doi"]) {
      expect(names).not.toContain(absent);
    }
    const published = t.properties.find((p) => p.name === "published");
    expect(published).toMatchObject({ value: "{{published}}", type: "date" });
  });

  it("targets the inbox folder and creates notes named after the page title", () => {
    const t = clipperTemplateFor(getSchema("article"), OPTS);
    expect(t.path).toBe("Clippings");
    expect(t.behavior).toBe("create");
    expect(t.noteNameFormat).toBe("{{title}}");
    expect(t.noteContentFormat).toBe("{{content}}");
  });

  it("gives the video template YouTube triggers matching detectType's family", () => {
    const t = clipperTemplateFor(getSchema("video"), OPTS);
    expect(t.triggers?.some((x) => x.includes("youtube\\.com/watch"))).toBe(true);
    expect(t.triggers?.some((x) => x.includes("youtu\\.be"))).toBe(true);
    expect(t.triggers?.some((x) => x.includes("shorts"))).toBe(true);
    expect(t.properties.find((p) => p.name === "channel")).toMatchObject({ value: "{{author}}" });
  });

  it("gives non-video templates no triggers", () => {
    expect(clipperTemplateFor(getSchema("article"), OPTS).triggers).toBeUndefined();
    expect(clipperTemplateFor(getSchema("dataset"), OPTS).triggers).toBeUndefined();
  });

  it("honors schema overrides (custom mappable fields appear)", () => {
    const schema = getSchema("article", {
      article: { fields: [{ key: "description", type: "string", required: false, source: "model", description: "meta description" }] },
    });
    const t = clipperTemplateFor(schema, OPTS);
    expect(t.properties.find((p) => p.name === "description")).toMatchObject({ value: "{{description}}", type: "text" });
  });
});

describe("clipperTemplateFileName", () => {
  it("matches the clipper's own export naming", () => {
    const t = clipperTemplateFor(getSchema("article"), OPTS);
    expect(clipperTemplateFileName(t)).toBe("companion-article-clipper.json");
  });
});

describe("serializeClipperTemplate", () => {
  it("emits the clipper import shape (schemaVersion first, tab indent)", () => {
    const t = clipperTemplateFor(getSchema("video"), OPTS);
    const json = serializeClipperTemplate(t);
    expect(json.startsWith('{\n\t"schemaVersion": "0.1.0",')).toBe(true);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "name", "behavior", "noteContentFormat", "properties", "triggers", "noteNameFormat", "path"]);
    // Round-trip: the clipper validates these property keys on import.
    for (const p of parsed.properties as Array<Record<string, unknown>>) {
      expect(Object.keys(p).sort()).toEqual(["name", "type", "value"]);
    }
  });
});

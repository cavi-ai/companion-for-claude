// Generate official Obsidian Web Clipper templates from Companion's source
// schemas, so clips land in the inbox already typed with everything the page
// itself knows (title, author, site, published, url). Enrichment then only
// fills the model-sourced remainder instead of converting a raw clip.
// Obsidian-free so it can be unit-tested.

import type { FieldType, SourceTypeSchema } from "./types";

export interface ClipperProperty {
  name: string;
  value: string;
  type: string;
}

export interface ClipperTemplate {
  schemaVersion: "0.1.0";
  name: string;
  behavior: "create";
  noteContentFormat: string;
  noteNameFormat: string;
  path: string;
  properties: ClipperProperty[];
  triggers?: string[];
}

/** Schema-field keys the page can answer directly, as Web Clipper variables. */
const PAGE_VARIABLES: Record<string, string> = {
  title: "{{title}}",
  author: "{{author}}",
  authors: "{{author}}",
  site: "{{site}}",
  publication: "{{site}}",
  published: "{{published}}",
  channel: "{{author}}",
  description: "{{description}}",
};

function clipperPropertyType(t: FieldType): string {
  switch (t) {
    case "date":
      return "date";
    case "number":
      return "number";
    case "string[]":
      return "multitext";
    default:
      return "text";
  }
}

/** URL triggers must mirror detectType's YouTube family so both sides agree. */
const VIDEO_TRIGGERS = [
  "https://(www\\.)?youtube\\.com/watch.*",
  "https://youtu\\.be/.*",
  "https://(www\\.)?youtube\\.com/shorts/.*",
];

export interface ClipperTemplateOptions {
  /** Inbox folder the clipper should write into (Companion watches it). */
  path: string;
  /** Tags stamped on every clip (unioned, never replaced, at enrichment). */
  tags: string[];
}

/** Build the Web Clipper template for one source schema. */
export function clipperTemplateFor(schema: SourceTypeSchema, opts: ClipperTemplateOptions): ClipperTemplate {
  const properties: ClipperProperty[] = [
    // Literal type: the clip lands pre-typed; detectType trusts this stamp.
    { name: "type", value: schema.type, type: "text" },
    // The clip URL drives provenance and (legacy) video detection.
    { name: "source", value: "{{url}}", type: "text" },
    // Lets enrichment tell clips made with a stale template apart from current ones.
    { name: "schema_version", value: String(schema.version), type: "number" },
  ];
  for (const field of schema.fields) {
    if (field.source !== "model") continue;
    const variable = PAGE_VARIABLES[field.key];
    if (!variable) continue;
    properties.push({ name: field.key, value: variable, type: clipperPropertyType(field.type) });
  }
  properties.push({ name: "clipped", value: "{{date}}", type: "date" });
  if (opts.tags.length > 0) {
    properties.push({ name: "tags", value: opts.tags.join(","), type: "multitext" });
  }
  const template: ClipperTemplate = {
    schemaVersion: "0.1.0",
    name: `Companion: ${schema.type}`,
    behavior: "create",
    noteContentFormat: "{{content}}",
    noteNameFormat: "{{title}}",
    path: opts.path,
    properties,
  };
  if (schema.type === "video") template.triggers = [...VIDEO_TRIGGERS];
  return template;
}

/** The file name the clipper itself would use on export (`<name>-clipper.json`). */
export function clipperTemplateFileName(template: ClipperTemplate): string {
  return `${template.name.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").toLowerCase()}-clipper.json`;
}

/** Serialize in the exact shape the clipper's own exporter emits (tab indent). */
export function serializeClipperTemplate(template: ClipperTemplate): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: template.schemaVersion,
    name: template.name,
    behavior: template.behavior,
    noteContentFormat: template.noteContentFormat,
    properties: template.properties,
  };
  if (template.triggers) ordered.triggers = template.triggers;
  ordered.noteNameFormat = template.noteNameFormat;
  ordered.path = template.path;
  return JSON.stringify(ordered, null, "\t") + "\n";
}

/**
 * A stable fingerprint of everything that shapes the exported templates:
 * resolved schemas (type, version, field shape) + inbox path + tags. Stored at
 * export time; when it no longer matches, the templates on the user's clipper
 * are stale and Companion offers to re-export.
 */
export function clipperFingerprint(schemas: SourceTypeSchema[], opts: ClipperTemplateOptions): string {
  const canonical = JSON.stringify({
    schemas: schemas
      .map((s) => ({
        type: s.type,
        version: s.version,
        fields: s.fields.map((f) => [f.key, f.type, f.source, f.required ? 1 : 0]),
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    path: opts.path,
    tags: [...opts.tags].sort(),
  });
  // djb2 — tiny, deterministic, collision-good-enough for drift detection.
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

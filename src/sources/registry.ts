import type { SourceType, SourceTypeSchema, SchemaField } from "./types";

const ARTICLE: SourceTypeSchema = {
  type: "article",
  version: 1,
  fields: [
    { key: "title", type: "string", required: true, source: "model", description: "the article's title" },
    { key: "author", type: "string", required: false, source: "model", description: "author name(s)" },
    { key: "site", type: "string", required: true, source: "model", description: "publication or site name" },
    { key: "published", type: "date", required: false, source: "model", description: "publish date as YYYY-MM-DD" },
    { key: "reading_time", type: "string", required: false, source: "model", description: "approx reading time, e.g. '8 min'" },
    { key: "topics", type: "string[]", required: false, source: "model", description: "3-6 short topic tags" },
    { key: "key_claims", type: "string[]", required: false, source: "model", description: "up to 3 key claims, one short sentence each" },
    { key: "summary", type: "string", required: true, source: "model", description: "one-sentence summary, max 25 words" },
  ],
};

const VIDEO: SourceTypeSchema = {
  type: "video",
  version: 1,
  fields: [
    { key: "title", type: "string", required: true, source: "model", description: "the video's title" },
    { key: "channel", type: "string", required: true, source: "model", description: "channel or creator name" },
    { key: "duration", type: "duration", required: false, source: "model", description: "length as mm:ss or hh:mm:ss" },
    { key: "published", type: "date", required: false, source: "model", description: "publish date as YYYY-MM-DD" },
    { key: "summary", type: "string", required: true, source: "model", description: "one-sentence summary, max 25 words" },
    { key: "chapters", type: "number", required: false, source: "derived", description: "chapter count (filled by Living Sources)" },
    { key: "key_moments", type: "string[]", required: false, source: "derived", description: "key timestamped moments (filled by Living Sources)" },
    { key: "transcript_summary", type: "string", required: false, source: "derived", description: "transcript summary (filled by Living Sources)" },
  ],
};

const DATASET: SourceTypeSchema = {
  type: "dataset",
  version: 1,
  fields: [
    { key: "title", type: "string", required: true, source: "model", description: "a short descriptive title for the dataset" },
    { key: "source", type: "string", required: false, source: "model", description: "publishing organization or site" },
    { key: "columns", type: "string[]", required: false, source: "derived", description: "column headers (parsed from the file)" },
    { key: "rows", type: "number", required: false, source: "derived", description: "row count (parsed from the file)" },
    { key: "period", type: "string", required: false, source: "model", description: "time period the data covers, if evident" },
    { key: "units", type: "string", required: false, source: "model", description: "the unit of the values, if evident" },
    { key: "license", type: "string", required: false, source: "model", description: "license or usage terms, if evident" },
    { key: "summary", type: "string", required: true, source: "model", description: "one-sentence summary of what the dataset contains" },
  ],
};

const BUILTINS: Record<SourceType, SourceTypeSchema> = { article: ARTICLE, video: VIDEO, dataset: DATASET };

export type SchemaOverrides = Partial<Record<SourceType, { version?: number; fields?: SchemaField[] }>>;

function clone(s: SourceTypeSchema): SourceTypeSchema {
  return { type: s.type, version: s.version, fields: s.fields.map((f) => ({ ...f })) };
}

/** Built-in schema for `type`, deep-merged with any user override (by field key). */
export function getSchema(type: SourceType, overrides?: SchemaOverrides): SourceTypeSchema {
  const base = clone(BUILTINS[type]);
  const ov = overrides?.[type];
  if (!ov) return base;
  if (typeof ov.version === "number") base.version = ov.version;
  for (const field of ov.fields ?? []) {
    const i = base.fields.findIndex((f) => f.key === field.key);
    if (i >= 0) base.fields[i] = { ...field };
    else base.fields.push({ ...field });
  }
  return base;
}

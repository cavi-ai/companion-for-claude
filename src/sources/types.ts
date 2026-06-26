// The shared interface for typed source capture. Both the foundation's
// note-writer and (later) the Living Sources artifact renderer consume a
// SourceRecord — so this file is the seam that keeps Living Sources additive.

export type SourceType = "article" | "video" | "dataset";

export type FieldType = "string" | "number" | "date" | "duration" | "string[]";

export type FieldValue = string | number | string[];

export interface SchemaField {
  key: string;
  type: FieldType;
  required: boolean;
  /** Guides the model's extraction; ignored for derived fields. */
  description: string;
  /** "model" = extracted by the LLM; "derived" = filled by a deterministic parser. */
  source: "model" | "derived";
}

export interface SourceTypeSchema {
  type: SourceType;
  version: number;
  fields: SchemaField[];
}

export type RawCapture =
  | { kind: "markdown"; path: string; basename: string; content: string; url?: string | undefined }
  | { kind: "datafile"; path: string; basename: string; ext: string; content: string };

export interface SourceRecord {
  type: SourceType;
  fields: Record<string, FieldValue>;
  provenance: {
    url?: string | undefined;
    capturedAt: string;
    schemaVersion: number;
    enrichedBy: "claude" | "local";
    assetPath?: string | undefined;
  };
}

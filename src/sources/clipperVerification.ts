import type { SourceType } from "./types";

export interface ClipperVerificationEntry {
  path: string;
  frontmatter: Record<string, unknown>;
}

export interface ClipperVerificationExpected {
  type: SourceType;
  schemaVersion: number;
  destination: string;
  fingerprint: string;
  baseTags: string[];
  pageKnownValues?: Record<string, string>;
}

export interface ClipperVerificationMismatch {
  field: string;
  expected: string;
  observed: string;
}

export interface ClipperVerificationResult {
  state: "verified" | "template-out-of-date" | "needs-attention" | "wrong-destination";
  path: string;
  fingerprint: string;
  mismatches: ClipperVerificationMismatch[];
}

const text = (value: unknown): string => {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 160);
  try { return JSON.stringify(value).slice(0, 160); }
  catch { return "unreadable value"; }
};

function validProvenance(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function tags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
  return [];
}

export function verifyClipperNote(
  entry: ClipperVerificationEntry,
  expected: ClipperVerificationExpected,
): ClipperVerificationResult {
  const destination = expected.destination.replace(/^\/+|\/+$/g, "");
  const path = entry.path.replace(/^\/+/, "");
  if (!(path === destination || path.startsWith(`${destination}/`))) {
    return {
      state: "wrong-destination",
      path: entry.path,
      fingerprint: expected.fingerprint,
      mismatches: [{ field: "path", expected: destination, observed: entry.path }],
    };
  }

  const mismatches: ClipperVerificationMismatch[] = [];
  const add = (field: string, wanted: string, observed: unknown): void => {
    if (mismatches.length < 12) mismatches.push({ field, expected: wanted, observed: text(observed) });
  };
  if (entry.frontmatter.type !== expected.type) add("type", expected.type, entry.frontmatter.type);
  if (Number(entry.frontmatter.schema_version) !== expected.schemaVersion) {
    add("schema_version", String(expected.schemaVersion), entry.frontmatter.schema_version);
  }
  const provenance = entry.frontmatter.source ?? entry.frontmatter.url;
  if (!validProvenance(provenance)) add("source", "a valid http(s) URL", provenance);
  const observedTags = new Set(tags(entry.frontmatter.tags));
  for (const required of expected.baseTags.map((tag) => tag.replace(/^#/, ""))) {
    if (!observedTags.has(required)) add("tags", `includes ${required}`, entry.frontmatter.tags);
  }
  for (const [field, value] of Object.entries(expected.pageKnownValues ?? {})) {
    if (text(entry.frontmatter[field]) !== value) add(field, value, entry.frontmatter[field]);
  }

  const onlyVersion = mismatches.length === 1 && mismatches[0]?.field === "schema_version";
  return {
    state: mismatches.length === 0 ? "verified" : onlyVersion ? "template-out-of-date" : "needs-attention",
    path: entry.path,
    fingerprint: expected.fingerprint,
    mismatches,
  };
}

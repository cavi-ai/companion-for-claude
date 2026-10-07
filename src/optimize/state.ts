import { tagId } from "../tags/vocabulary";
import { pairKey } from "./tagScan";

export interface StoredVerdict {
  verdict: "merge" | "keep";
  canonical?: string;
  a: string;
  b: string;
  model: string;
  at: string;
}

export interface StoredTypeVerdict {
  /** `null`: the model found no fitting type. */
  type: string | null;
  model: string;
  at: string;
  /** The note's `stat.mtime` when it was judged. */
  mtime: number;
  /** The proposable type names, comma-joined, at judging time; a `null` verdict is valid only while it matches. */
  types?: string;
}

export interface OptimizeState {
  dismissed: string[];
  /** `<source>\u0000<target>` pairs the user dismissed in the link weave review. */
  dismissedLinks?: string[];
  verdicts: Record<string, StoredVerdict>;
  /** Model type verdicts by note path. */
  typeVerdicts?: Record<string, StoredTypeVerdict>;
  /** Note paths the user dismissed in the type weave review. */
  dismissedTypes?: string[];
  lastBackgroundRun?: string;
}

const MAX_DISMISSED = 2000;
const MAX_VERDICTS = 2000;

function storedVerdict(id: string, raw: unknown): StoredVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.verdict !== "merge" && v.verdict !== "keep") return null;
  if (typeof v.a !== "string" || typeof v.b !== "string" || typeof v.model !== "string" || typeof v.at !== "string") return null;
  if (v.canonical !== undefined && typeof v.canonical !== "string") return null;
  if (pairKey(tagId(v.a), tagId(v.b)) !== id) return null;
  if (v.verdict === "merge" && (typeof v.canonical !== "string" || ![tagId(v.a), tagId(v.b)].includes(tagId(v.canonical)))) return null;
  return {
    verdict: v.verdict,
    ...(v.canonical !== undefined ? { canonical: v.canonical } : {}),
    a: v.a,
    b: v.b,
    model: v.model,
    at: v.at,
  };
}

function normalizeVerdicts(raw: unknown): Record<string, StoredVerdict> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const valid: Array<[string, StoredVerdict]> = [];
  for (const [id, entry] of Object.entries(raw)) {
    const verdict = storedVerdict(id, entry);
    if (verdict) valid.push([id, verdict]);
  }
  valid.sort((x, y) => (x[1].at < y[1].at ? 1 : x[1].at > y[1].at ? -1 : 0));
  return Object.fromEntries(valid.slice(0, MAX_VERDICTS));
}

function storedTypeVerdict(raw: unknown): StoredTypeVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.type !== null && typeof v.type !== "string") return null;
  if (typeof v.model !== "string" || typeof v.at !== "string" || typeof v.mtime !== "number" || !Number.isFinite(v.mtime)) return null;
  if (v.type === null && typeof v.types !== "string") return null;
  return { type: v.type, model: v.model, at: v.at, mtime: v.mtime, ...(typeof v.types === "string" ? { types: v.types } : {}) };
}

function normalizeTypeVerdicts(raw: unknown): Record<string, StoredTypeVerdict> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const valid: Array<[string, StoredTypeVerdict]> = [];
  for (const [path, entry] of Object.entries(raw)) {
    const verdict = storedTypeVerdict(entry);
    if (verdict) valid.push([path, verdict]);
  }
  valid.sort((x, y) => (x[1].at < y[1].at ? 1 : x[1].at > y[1].at ? -1 : 0));
  return Object.fromEntries(valid.slice(0, MAX_VERDICTS));
}

function normalizeIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry: unknown = list[i];
    if (typeof entry !== "string" || seen.has(entry)) continue;
    seen.add(entry);
    newestFirst.push(entry);
    if (newestFirst.length === MAX_DISMISSED) break;
  }
  return newestFirst.reverse();
}

export function normalizeOptimizeState(raw: unknown): OptimizeState {
  const source = raw as {
    dismissed?: unknown;
    dismissedLinks?: unknown;
    verdicts?: unknown;
    typeVerdicts?: unknown;
    dismissedTypes?: unknown;
    lastBackgroundRun?: unknown;
  } | null;
  const verdicts = normalizeVerdicts(source?.verdicts);
  const lastBackgroundRun = typeof source?.lastBackgroundRun === "string" ? { lastBackgroundRun: source.lastBackgroundRun } : {};
  const dismissedLinks = normalizeIds(source?.dismissedLinks);
  const typeVerdicts = normalizeTypeVerdicts(source?.typeVerdicts);
  const dismissedTypes = normalizeIds(source?.dismissedTypes);
  return {
    dismissed: normalizeIds(source?.dismissed),
    verdicts,
    ...(dismissedLinks.length > 0 ? { dismissedLinks } : {}),
    ...(Object.keys(typeVerdicts).length > 0 ? { typeVerdicts } : {}),
    ...(dismissedTypes.length > 0 ? { dismissedTypes } : {}),
    ...lastBackgroundRun,
  };
}

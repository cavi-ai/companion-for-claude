import { cosineSimilarity } from "../semantic/similarity";
import { variantKeys } from "../tags/resolve";
import type { TagStat, Vocabulary } from "../tags/vocabulary";
import type { StoredVerdict } from "./state";

export type MergeEvidence = "separator" | "plural" | "plural-loose" | "token-order" | "leaf" | "typo" | "semantic";
export interface MergeCandidate {
  id: string;
  from: string;
  to: string;
  evidence: MergeEvidence[];
  score: number;
  fromCount: number;
  toCount: number;
  verdict?: StoredVerdict;
}
export interface TagScanLimits {
  maxCandidates: number;
  semanticThreshold: number;
  lowConsumer: number;
  established: number;
  maxEstablished: number;
}
export const DEFAULT_SCAN_LIMITS: TagScanLimits = {
  maxCandidates: 200,
  semanticThreshold: 0.86,
  lowConsumer: 2,
  established: 3,
  maxEstablished: 300,
};
export interface TagScanInput {
  vocab: Vocabulary;
  centroid?: (tag: string) => number[] | null;
  dismissed?: ReadonlySet<string>;
  limits?: Partial<TagScanLimits>;
}
export interface TagScanReport {
  totalTags: number;
  singleUse: number;
  candidates: MergeCandidate[];
  dropped: number;
}

const MAX_KEYS = 8;
const IRREGULAR_PLURALS: Record<string, string> = {
  analyses: "analysis",
  hypotheses: "hypothesis",
  theses: "thesis",
  crises: "crisis",
  matrices: "matrix",
  indices: "index",
  vertices: "vertex",
  criteria: "criterion",
};
const SCORES: Record<Exclude<MergeEvidence, "semantic">, number> = {
  separator: 1,
  plural: 1,
  "token-order": 0.8,
  "plural-loose": 0.7,
  leaf: 0.6,
  typo: 0.6,
};

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function mostUsed(a: TagStat, b: TagStat): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (a.tag.length !== b.tag.length) return a.tag.length < b.tag.length;
  return a.tag < b.tag;
}

function looseForms(word: string): string[] {
  const forms = [word];
  if (word.length >= 3 && !word.endsWith("ss")) {
    if (word.endsWith("s")) forms.push(word.slice(0, -1));
    if (word.endsWith("es")) forms.push(word.slice(0, -2));
  }
  const irregular = IRREGULAR_PLURALS[word];
  if (irregular) forms.push(irregular);
  return forms;
}

function looseKeys(tag: string): string[] {
  let combos: string[][] = [[]];
  for (const segment of tag.split("/")) {
    let forms = [""];
    for (const word of segment.split(/[-_]/)) {
      const next: string[] = [];
      for (const prefix of forms) for (const form of looseForms(word)) next.push(prefix + form);
      forms = next;
    }
    const grown: string[][] = [];
    for (const prefix of combos) for (const form of forms) grown.push([...prefix, form]);
    combos = grown;
  }
  return [...new Set(combos.map((c) => c.join("/")))].slice(0, MAX_KEYS);
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  const min = Math.min(a.length, b.length);
  while (i < min && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

function tokenShape(tag: string): { sorted: string; ordered: string } {
  const segments = tag.split("/").map((s) => s.split(/[-_]/));
  return {
    sorted: segments.map((words) => [...words].sort().join("-")).join("/"),
    ordered: segments.map((words) => words.join("-")).join("/"),
  };
}

export function scanTags(input: TagScanInput): TagScanReport {
  const limits: TagScanLimits = { ...DEFAULT_SCAN_LIMITS, ...input.limits };
  const { vocab } = input;
  const stats = [...vocab.values()];
  const found = new Map<string, { from: TagStat; to: TagStat; evidence: Set<MergeEvidence>; score: number }>();

  const add = (a: TagStat, b: TagStat, evidence: MergeEvidence, score: number): void => {
    if (a.tag === b.tag) return;
    const id = pairKey(a.tag, b.tag);
    if (input.dismissed?.has(id)) return;
    let entry = found.get(id);
    if (!entry) {
      const aFrom =
        a.count !== b.count
          ? a.count < b.count
          : a.tag.length !== b.tag.length
            ? a.tag.length > b.tag.length
            : a.tag > b.tag;
      entry = { from: aFrom ? a : b, to: aFrom ? b : a, evidence: new Set(), score: 0 };
      found.set(id, entry);
    }
    entry.evidence.add(evidence);
    entry.score = Math.max(entry.score, score);
  };
  const has = (a: TagStat, b: TagStat, ...kinds: MergeEvidence[]): boolean => {
    const entry = found.get(pairKey(a.tag, b.tag));
    return !!entry && kinds.some((k) => entry.evidence.has(k));
  };
  const hubPairs = (buckets: Map<string, TagStat[]>, emit: (a: TagStat, b: TagStat) => void): void => {
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      if (bucket.length === 2) {
        emit(bucket[0] as TagStat, bucket[1] as TagStat);
        continue;
      }
      let hub = bucket[0] as TagStat;
      for (const s of bucket) if (mostUsed(s, hub)) hub = s;
      for (const s of bucket) if (s !== hub) emit(s, hub);
    }
  };
  const bucketBy = (keysOf: (s: TagStat) => string[]): Map<string, TagStat[]> => {
    const buckets = new Map<string, TagStat[]>();
    for (const s of stats) {
      for (const key of keysOf(s)) {
        const list = buckets.get(key);
        if (list) list.push(s);
        else buckets.set(key, [s]);
      }
    }
    return buckets;
  };
  const keys = new Map(stats.map((s) => [s.tag, variantKeys(s.tag)]));

  hubPairs(bucketBy((s) => [(keys.get(s.tag) as { separator: string }).separator]), (a, b) =>
    add(a, b, "separator", SCORES.separator),
  );
  hubPairs(bucketBy((s) => (keys.get(s.tag) as { plural: string[] }).plural), (a, b) => {
    if (!has(a, b, "separator")) add(a, b, "plural", SCORES.plural);
  });
  hubPairs(bucketBy((s) => looseKeys(s.tag)), (a, b) => {
    if (!has(a, b, "separator", "plural")) add(a, b, "plural-loose", SCORES["plural-loose"]);
  });

  const shapes = new Map(stats.map((s) => [s.tag, tokenShape(s.tag)]));
  hubPairs(bucketBy((s) => [(shapes.get(s.tag) as { sorted: string }).sorted]), (a, b) => {
    if ((shapes.get(a.tag) as { ordered: string }).ordered !== (shapes.get(b.tag) as { ordered: string }).ordered) {
      add(a, b, "token-order", SCORES["token-order"]);
    }
  });

  const leaves = new Map<string, TagStat[]>();
  for (const s of stats) {
    if (!s.tag.includes("/")) continue;
    const leaf = s.tag.slice(s.tag.lastIndexOf("/") + 1);
    const list = leaves.get(leaf);
    if (list) list.push(s);
    else leaves.set(leaf, [s]);
  }
  for (const [leaf, owners] of leaves) {
    const plain = vocab.get(leaf);
    if (plain && owners.length === 1) add(plain, owners[0] as TagStat, "leaf", SCORES.leaf);
  }

  const deletionIndex = new Map<string, TagStat[]>();
  for (const s of stats) {
    if (s.tag.length < 6) continue;
    const chars = [...s.tag];
    const forms = new Set([s.tag]);
    for (let i = 0; i < chars.length; i++) forms.add(chars.slice(0, i).join("") + chars.slice(i + 1).join(""));
    for (const form of forms) {
      const list = deletionIndex.get(form);
      if (list) list.push(s);
      else deletionIndex.set(form, [s]);
    }
  }
  const typoSeen = new Set<string>();
  const sharesForm = (a: TagStat, b: TagStat): boolean => {
    const plural = new Set((keys.get(a.tag) as { plural: string[] }).plural);
    if ((keys.get(b.tag) as { plural: string[] }).plural.some((k) => plural.has(k))) return true;
    const loose = new Set(looseKeys(a.tag));
    return looseKeys(b.tag).some((k) => loose.has(k));
  };
  for (const bucket of deletionIndex.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i] as TagStat;
        const b = bucket[j] as TagStat;
        const id = pairKey(a.tag, b.tag);
        if (typoSeen.has(id)) continue;
        typoSeen.add(id);
        if (!withinOneEdit(a.tag, b.tag) || a.tag.replace(/\d/g, "") === b.tag.replace(/\d/g, "")) continue;
        if (has(a, b, "plural", "plural-loose") || sharesForm(a, b)) continue;
        if (Math.max(a.count, b.count) >= 2) add(a, b, "typo", SCORES.typo);
      }
    }
  }

  if (input.centroid) {
    const centroid = input.centroid;
    const established = stats
      .filter((s) => s.count >= limits.established)
      .sort((x, y) => (mostUsed(x, y) ? -1 : 1))
      .slice(0, limits.maxEstablished);
    for (const low of stats) {
      if (low.count > limits.lowConsumer) continue;
      const lowVec = centroid(low.tag);
      if (!lowVec) continue;
      let best: TagStat | null = null;
      let bestScore = limits.semanticThreshold;
      for (const target of established) {
        if (target.tag === low.tag) continue;
        const vec = centroid(target.tag);
        if (!vec || vec.length !== lowVec.length) continue;
        const cos = cosineSimilarity(lowVec, vec);
        if (cos >= bestScore) {
          best = target;
          bestScore = cos;
        }
      }
      if (best) add(low, best, "semantic", bestScore);
    }
  }

  const all: MergeCandidate[] = [...found].map(([id, e]) => ({
    id,
    from: e.from.tag,
    to: e.to.tag,
    evidence: [...e.evidence],
    score: e.score,
    fromCount: e.from.count,
    toCount: e.to.count,
  }));
  all.sort((x, y) => y.score - x.score || x.fromCount - y.fromCount || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    totalTags: stats.length,
    singleUse: stats.filter((s) => s.count === 1).length,
    candidates: all.slice(0, limits.maxCandidates),
    dropped: Math.max(0, all.length - limits.maxCandidates),
  };
}

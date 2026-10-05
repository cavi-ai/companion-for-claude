import { normalizeTag } from "../indexing/frontmatter";
import type { TagStat, Vocabulary } from "./vocabulary";

export type TagMatch = "exact" | "variant" | "new";
export type VariantRule = "separator" | "plural";
export interface ResolvedTag {
  input: string;
  tag: string;
  match: TagMatch;
  via?: VariantRule;
}

const MAX_PLURAL_KEYS = 8;
const PLURAL_INVARIANT = new Set([
  "news", "series", "species", "means", "windows", "rails", "pandas", "goods", "customs", "blues", "https", "canvas",
  "sales", "electronics", "acoustics", "logistics", "statistics", "economics", "mechanics", "dynamics", "ethics",
  "politics", "semantics", "optics", "graphics", "analytics", "physics", "mathematics", "robotics", "genetics",
  "linguistics",
]);

function singularForms(word: string): string[] {
  if (word.length <= 3 || PLURAL_INVARIANT.has(word)) return [word];
  if (word.endsWith("ies") && word.length > 4) {
    const stem = word.slice(0, -3);
    return [`${stem}y`, `${stem}ie`];
  }
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return [word.slice(0, -2), word.slice(0, -1)];
  if (word.endsWith("ses")) {
    const stem = word.slice(0, -2);
    return stem.length >= 4 ? [stem, word.slice(0, -1)] : [word.slice(0, -1)];
  }
  if (word.endsWith("s") && !word.endsWith("ss")) return [word.slice(0, -1), word];
  return [word];
}

export function variantKeys(tag: string): { separator: string; plural: string[] } {
  const segments = tag.split("/");
  let combos: string[][] = [[]];
  for (const segment of segments) {
    let forms: string[] = [""];
    for (const word of segment.split(/[-_]/)) {
      const next: string[] = [];
      for (const prefix of forms) for (const form of singularForms(word)) next.push(prefix + form);
      forms = next;
    }
    const grown: string[][] = [];
    for (const prefix of combos) for (const form of forms) grown.push([...prefix, form]);
    combos = grown;
  }
  const plural = [...new Set(combos.map((c) => c.join("/")))].slice(0, MAX_PLURAL_KEYS);
  return { separator: segments.map((s) => s.replace(/[-_]/g, "")).join("/"), plural };
}

function better(a: TagStat, b: TagStat): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (a.tag.length !== b.tag.length) return a.tag.length < b.tag.length;
  return a.tag < b.tag;
}

function addTo(map: Map<string, TagStat[]>, key: string, stat: TagStat): void {
  const list = map.get(key);
  if (list) list.push(stat);
  else map.set(key, [stat]);
}

export function createTagResolver(vocab: Vocabulary): (raw: string) => ResolvedTag | null {
  const separatorIndex = new Map<string, TagStat[]>();
  const pluralIndex = new Map<string, TagStat[]>();
  for (const stat of vocab.values()) {
    const keys = variantKeys(stat.tag);
    addTo(separatorIndex, keys.separator, stat);
    for (const key of keys.plural) addTo(pluralIndex, key, stat);
  }

  return (raw) => {
    const input = normalizeTag(raw);
    if (input.length === 0) return null;
    if (vocab.has(input)) return { input, tag: input, match: "exact" };
    const keys = variantKeys(input);
    const family = new Map<string, TagStat>();
    for (const s of separatorIndex.get(keys.separator) ?? []) family.set(s.tag, s);
    for (const key of keys.plural) for (const s of pluralIndex.get(key) ?? []) family.set(s.tag, s);
    let winner: TagStat | undefined;
    for (const s of family.values()) if (!winner || better(s, winner)) winner = s;
    if (!winner) return { input, tag: input, match: "new" };
    const via: VariantRule = variantKeys(winner.tag).separator === keys.separator ? "separator" : "plural";
    return { input, tag: winner.tag, match: "variant", via };
  };
}

export function resolveTags(raw: string[], vocab: Vocabulary): ResolvedTag[] {
  const resolve = createTagResolver(vocab);
  const out: ResolvedTag[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const resolved = resolve(r);
    if (!resolved || seen.has(resolved.tag)) continue;
    seen.add(resolved.tag);
    out.push(resolved);
  }
  return out;
}

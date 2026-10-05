import { normalizeTag } from "../indexing/frontmatter";

export interface TagStat {
  tag: string;
  count: number;
  notes: string[];
}

export type Vocabulary = ReadonlyMap<string, TagStat>;

export function tagId(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase();
}

export function buildVocabulary(
  files: Array<{ path: string; tags: string[] }>,
  key: (raw: string) => string = normalizeTag,
): Vocabulary {
  const notes = new Map<string, Set<string>>();
  for (const file of files) {
    for (const raw of file.tags) {
      const tag = key(raw);
      if (tag.length === 0) continue;
      let set = notes.get(tag);
      if (!set) notes.set(tag, (set = new Set()));
      set.add(file.path);
    }
  }
  const vocab = new Map<string, TagStat>();
  for (const [tag, set] of notes) vocab.set(tag, { tag, count: set.size, notes: [...set] });
  return vocab;
}

function byCountThenName(a: TagStat, b: TagStat): number {
  return b.count - a.count || a.tag.localeCompare(b.tag);
}

export function selectPromptTags(vocab: Vocabulary, content: string, limit = 80): string[] {
  const words = new Set(content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const stats = [...vocab.values()].sort(byCountThenName);
  const matched = stats
    .filter((s) => s.tag.split(/[/_-]/).filter(Boolean).every((w) => words.has(w)))
    .slice(0, Math.floor(limit / 2));
  const out = matched.map((s) => s.tag);
  const seen = new Set(out);
  for (const s of stats) {
    if (out.length >= limit) break;
    if (!seen.has(s.tag)) {
      seen.add(s.tag);
      out.push(s.tag);
    }
  }
  return out;
}

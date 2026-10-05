export function formatTagList(tags: string[], newTags: readonly string[]): string {
  const fresh = new Set(newTags);
  return tags.map((t) => (fresh.has(t) ? `${t} (new)` : t)).join(", ");
}

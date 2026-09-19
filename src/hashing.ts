// Shared, pure hashing/serialization helpers. Extracted because the algorithm
// was copy-pasted across five modules and the deterministic serializer across
// two — one of which had already drifted (`"undefined"` vs `"null"` fallback),
// exactly the failure mode duplication invites. No Obsidian, no IO.

/**
 * FNV-1a 32-bit hash of a string. Fast, stable, non-cryptographic — for change
 * detection and cache keys, not collision resistance.
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a as 8 lowercase hex digits (callers add their own `fnv1a-` prefix). */
export function fnv1aHex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}

/**
 * Deterministic JSON: object keys are sorted by code unit so equal values
 * always serialize identically, unlike `JSON.stringify` whose key order follows
 * insertion. `undefined` serializes as `null` (a single documented choice).
 */
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

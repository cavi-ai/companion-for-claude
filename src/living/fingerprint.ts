// Content fingerprint for living views: detects that a source changed since its
// view was built. Not a security hash. Pure.

/** FNV-1a over UTF-16 code units, plus the length, as `<8 hex>-<length>`. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

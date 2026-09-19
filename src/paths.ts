// Pure path-safety predicates shared by the MCP vault-path guard (which
// normalizes first) and the research repository's canonical-path guard (which
// does not). The two guards intentionally enforce different policies — MCP
// accepts loose user input and normalizes it, research only accepts canonical
// records — but the security-critical question ("does this escape the root?")
// must have one answer, not two that can drift.

/**
 * True when a slash-separated path contains a segment that escapes the vault
 * root: an absolute leading slash or any `..` segment. Callers that normalize
 * first (MCP) and callers that take canonical paths as-is (research) both use
 * this on the same semantics.
 */
export function hasPathTraversal(path: string): boolean {
  return path.startsWith("/") || path.split("/").some((segment) => segment === "..");
}

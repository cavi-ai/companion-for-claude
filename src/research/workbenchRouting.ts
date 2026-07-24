import { RESEARCH_TYPE_NAMES } from "./types";

const CANONICAL_COLLECTIONS = ["Sources", "Evidence", "Claims", "Questions", "Documents"] as const;
const LINKED_RESEARCH_TYPES: ReadonlySet<string> = new Set(
  RESEARCH_TYPE_NAMES.filter((type) => type !== "research-project"),
);

function normalizeCandidate(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return normalized;
}

export function resolveResearchProjectLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const target = trimmed.startsWith("[[") && trimmed.endsWith("]]" ) ? trimmed.slice(2, -2).split("|", 1)[0] : trimmed;
  const normalized = normalizeCandidate(target ?? "");
  if (!normalized) return undefined;
  const withExtension = normalized.endsWith("/Project") ? `${normalized}.md` : normalized;
  return withExtension.endsWith("/Project.md") ? withExtension : undefined;
}

function projectFromCanonicalRecord(path: string): string | undefined {
  const normalized = normalizeCandidate(path);
  if (!normalized) return undefined;
  if (normalized.endsWith("/Project.md")) return normalized;
  for (const collection of CANONICAL_COLLECTIONS) {
    const marker = `/${collection}/`;
    const index = normalized.indexOf(marker);
    if (index > 0 && normalized.endsWith(".md")) return `${normalized.slice(0, index)}/Project.md`;
  }
  return undefined;
}

export function inferResearchProjectPath(
  filePath: string,
  frontmatter?: Record<string, unknown>,
): string | undefined {
  const type = frontmatter?.type;
  if (type === "research-project") return resolveResearchProjectLink(filePath);
  if (typeof type !== "string" || !LINKED_RESEARCH_TYPES.has(type)) return undefined;
  return resolveResearchProjectLink(frontmatter?.project);
}

export function projectPathForActivation(explicit: unknown, inferred: unknown, selected: unknown): string | undefined {
  return resolveResearchProjectLink(explicit) ?? resolveResearchProjectLink(inferred) ?? resolveResearchProjectLink(selected);
}

export function isResearchProjectChange(currentProject: string | undefined, changedPath: string, oldPath?: string): boolean {
  const current = resolveResearchProjectLink(currentProject);
  if (!current) return false;
  return [changedPath, oldPath].some((path) => path !== undefined && projectFromCanonicalRecord(path) === current);
}

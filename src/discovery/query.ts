import type { ProjectSnapshot } from "../research/graph";
import type { DiscoveryQuery } from "./types";

const normalizeLine = (value: string): string => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export function deriveDiscoveryQuery(snapshot: ProjectSnapshot): DiscoveryQuery {
  const lines = [
    snapshot.project.question.trim(),
    ...snapshot.claims.filter((claim) => claim.reviewState === "reviewed").map((claim) => claim.proposition.trim()),
  ].filter(Boolean);
  const seen = new Set<string>();
  const text = lines.filter((line) => {
    const normalized = normalizeLine(line);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join("\n").slice(0, 2_000);
  return { text, projectPath: snapshot.project.path };
}

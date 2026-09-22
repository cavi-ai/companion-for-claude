// Ranking and empty-state logic for the Similar-notes Bases view; pure, no Obsidian imports.

export type SimilarViewState = "semantic-off" | "no-note" | "no-neighbours" | "no-overlap" | "ready";

export const SIMILAR_VIEW_MESSAGES: Record<Exclude<SimilarViewState, "ready">, string> = {
  "semantic-off": "Turn on semantic search in Companion settings to rank notes by similarity.",
  "no-note": "Open a note to see which notes in this base are most similar to it.",
  "no-neighbours": "No neighbours yet. Build the semantic index in Companion settings.",
  "no-overlap": "None of this note's nearest neighbours are in this base.",
};

export function isNoteAnchor(path: string | null | undefined): path is string {
  return typeof path === "string" && path.toLowerCase().endsWith(".md");
}

export function rankWithinBase(
  related: readonly { path: string; score: number }[],
  basePaths: ReadonlySet<string>,
  anchorPath: string,
  limit: number,
): { path: string; score: number }[] {
  return related.filter((h) => h.path !== anchorPath && basePaths.has(h.path)).slice(0, limit);
}

export function similarViewState(input: { semanticEnabled: boolean; anchorPath: string | null; relatedCount: number; rankedCount: number }): SimilarViewState {
  if (!input.semanticEnabled) return "semantic-off";
  if (input.anchorPath === null) return "no-note";
  if (input.relatedCount === 0) return "no-neighbours";
  if (input.rankedCount === 0) return "no-overlap";
  return "ready";
}

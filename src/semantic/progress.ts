import type { IndexBuildProgress } from "./indexer";

export interface SemanticIndexProgress extends IndexBuildProgress {
  state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
}

/** Remaining note sizes are unknown until read: extrapolate from finished
 * notes and include the known remainder of the current note. */
export function estimatedRemainingMs(progress: SemanticIndexProgress, now: number): number | null {
  if (progress.state !== "running" || progress.phase !== "embedding"
    || progress.filesCompleted < 3 || progress.chunksEmbedded < 10) return null;
  const elapsed = Math.max(0, now - progress.startedAt);
  if (!elapsed) return null;
  const average = progress.completedFileChunks / progress.filesCompleted;
  const unknownFiles = Math.max(0, progress.totalFiles - progress.filesCompleted - 1);
  const remaining = Math.max(0, progress.currentFileChunksTotal - progress.currentFileChunksCompleted) + average * unknownFiles;
  return remaining > 0 ? remaining * elapsed / progress.chunksEmbedded : null;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatIndexProgress(progress: SemanticIndexProgress, now = Date.now()): string {
  const elapsed = Math.max(0, (progress.finishedAt ?? now) - progress.startedAt);
  const remaining = estimatedRemainingMs(progress, now);
  const resolution = remaining !== null && remaining < 60_000 ? 1000 : 30_000;
  const estimate = progress.phase === "saving" ? "Saving index…"
    : remaining === null ? "Estimating…" : `~${duration(Math.ceil(remaining / resolution) * resolution)}`;
  const notes = progress.totalFiles ? ` · ${progress.filesCompleted}/${progress.totalFiles} notes` : "";
  return `${progress.chunksEmbedded.toLocaleString()} chunks embedded${notes}\nElapsed: ${duration(elapsed)}\nEstimated remaining: ${estimate}`;
}

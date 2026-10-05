import type { MergeCandidate, TagScanReport } from "./tagScan";

export interface TagMergeReviewDeps {
  scan(): Promise<TagScanReport>;
  open(candidates: MergeCandidate[]): void;
  notice(text: string): void;
  done(): void;
}

export async function openTagMergeReview(deps: TagMergeReviewDeps): Promise<void> {
  let report: TagScanReport;
  try {
    report = await deps.scan();
  } catch (error) {
    deps.notice(`Tag scan failed: ${error instanceof Error ? error.message : String(error)}`);
    deps.done();
    return;
  }
  deps.open(report.candidates);
}

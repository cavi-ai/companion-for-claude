import { describe, expect, it, vi } from "vitest";
import { openTagMergeReview } from "../../src/optimize/review";

describe("openTagMergeReview", () => {
  it("opens the review with the scanned candidates", async () => {
    const open = vi.fn();
    const done = vi.fn();
    const candidates = [{ id: "a|b", from: "a", to: "b", evidence: ["plural" as const], score: 1, fromCount: 1, toCount: 2 }];
    await openTagMergeReview({ scan: async () => ({ totalTags: 2, singleUse: 1, candidates, dropped: 0 }), open, notice: vi.fn(), done });
    expect(open).toHaveBeenCalledWith(candidates);
    expect(done).not.toHaveBeenCalled();
  });

  it("surfaces a scan failure as a notice and finishes once", async () => {
    const open = vi.fn();
    const notice = vi.fn();
    const done = vi.fn();
    await openTagMergeReview({ scan: async () => { throw new Error("boom"); }, open, notice, done });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("Tag scan failed: boom");
    expect(done).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});

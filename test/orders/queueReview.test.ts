import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, clearNotices, getNoticeMessages } from "obsidian";
import type { ReviewApplyResult } from "../../src/edit/reviewAndApply";
import type { QueuedEdit } from "../../src/orders/editQueue";
import { discardQueuedEdit, reviewQueuedEdit } from "../../src/orders/queueReview";

const item: QueuedEdit = { id: "r#0", orderId: "o.md", orderName: "o", runPath: "r", path: "Meetings/a.md", edits: [{ old_str: "- [ ] ship", new_str: "- [x] ship" }], description: "Mark shipped", createdAt: 1 };

function setup(content: string | null, result: ReviewApplyResult = { applied: 1, total: 1, remaining: [], cancelled: false }) {
  const app = new App();
  if (content !== null) app.vault.seed("Meetings/a.md", content);
  let queue: QueuedEdit[] = [item];
  const review = vi.fn(async () => result);
  const onChanged = vi.fn();
  const deps = {
    app: app as never,
    getQueue: () => queue,
    setQueue: async (next: QueuedEdit[]) => { queue = next; },
    inlineEnabled: () => false,
    onChanged,
    review: review as never,
  };
  return { deps, review, onChanged, queue: () => queue };
}

beforeEach(() => clearNotices());

describe("reviewQueuedEdit", () => {
  it("removes the item once every hunk is applied", async () => {
    const s = setup("- [ ] ship\n");
    await reviewQueuedEdit(s.deps, "r#0");
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.queue()).toEqual([]);
    expect(s.onChanged).toHaveBeenCalled();
  });

  it("keeps only the rejected hunks after a partial accept", async () => {
    const s = setup("- [ ] ship\n", { applied: 0, total: 1, remaining: [{ old_str: "- [ ] ship\n", new_str: "- [x] ship\n" }], cancelled: false });
    await reviewQueuedEdit(s.deps, "r#0");
    expect(s.queue()).toHaveLength(1);
    expect(s.queue()[0]?.edits).toEqual([{ old_str: "- [ ] ship\n", new_str: "- [x] ship\n" }]);
  });

  it("leaves the queue alone when the review is cancelled", async () => {
    const s = setup("- [ ] ship\n", { applied: 0, total: 1, remaining: item.edits, cancelled: true });
    await reviewQueuedEdit(s.deps, "r#0");
    expect(s.queue()).toEqual([item]);
    expect(s.onChanged).not.toHaveBeenCalled();
  });

  it("warns and keeps the item queued when the note no longer matches, writing nothing", async () => {
    const s = setup("- [x] already shipped\n");
    await reviewQueuedEdit(s.deps, "r#0");
    expect(s.review).not.toHaveBeenCalled();
    expect(s.queue()).toEqual([item]);
    expect(getNoticeMessages()).toEqual(["This edit no longer matches Meetings/a.md. Discard it or edit the note."]);
  });

  it("warns when the target note is missing", async () => {
    const s = setup(null);
    await reviewQueuedEdit(s.deps, "r#0");
    expect(s.review).not.toHaveBeenCalled();
    expect(s.queue()).toEqual([item]);
    expect(getNoticeMessages()).toEqual(["Note missing: Meetings/a.md"]);
  });

  it("ignores an unknown id", async () => {
    const s = setup("- [ ] ship\n");
    await reviewQueuedEdit(s.deps, "nope");
    expect(s.review).not.toHaveBeenCalled();
  });
});

describe("discardQueuedEdit", () => {
  it("removes the item and notifies", async () => {
    const s = setup("- [ ] ship\n");
    await discardQueuedEdit(s.deps, "r#0");
    expect(s.queue()).toEqual([]);
    expect(s.onChanged).toHaveBeenCalled();
  });
});

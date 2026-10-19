import { describe, expect, it } from "vitest";
import { ActivityStore } from "../../src/activity/store";

function failedBatch(paths: string[], options: { maxDetails?: number; total?: number } = {}) {
  const store = new ActivityStore(options);
  const id = store.start({ id: "batch", kind: "source-enrichment", title: "Enriching Inbox", total: options.total ?? paths.length });
  store.fail(id, {
    completed: paths.length, failed: paths.length,
    details: paths.map((key) => ({ key, label: key, message: "Invalid properties", state: "error" as const })),
    recovery: [{ id: "retry", label: "Review failed notes", kind: "retry" }],
  });
  return { store, id };
}

describe("ActivityStore failure recovery", () => {
  it("resolves only the requested failure and does not count a duplicate success", () => {
    const { store, id } = failedBatch(["A.md", "B.md"]);
    const other = store.start({ id: "other", kind: "link-review", title: "Other work" });
    store.fail(other, { failed: 1 });
    expect(store.resolveFailure(id, "A.md", "Enriched")).toBe(true);
    expect(store.resolveFailure(id, "A.md", "Enriched")).toBe(false);
    expect(store.snapshot().records.find((r) => r.id === id)).toMatchObject({
      failed: 1, succeeded: 1, state: "needs-attention",
      details: [{ key: "B.md", state: "error" }, { key: "A.md", state: "success", message: "Enriched" }],
    });
    expect(store.snapshot().records.find((r) => r.id === other)?.failed).toBe(1);
    store.dispose();
  });

  it("finishes after the last failure resolves and clears obsolete recovery actions", () => {
    const { store, id } = failedBatch(["A.md"]);
    expect(store.resolveFailure(id, "A.md")).toBe(true);
    expect(store.snapshot().records[0]).toMatchObject({ state: "succeeded", failed: 0, succeeded: 1, recovery: [] });
    expect(JSON.parse(JSON.stringify(store.snapshot()))).toEqual(store.snapshot());
    store.dispose();
  });

  it("retains retry identities after display details are evicted or truncated", () => {
    const long = "folder/".repeat(100) + "A.md";
    const { store, id } = failedBatch([long, "B.md"], { maxDetails: 1 });
    expect(store.resolveFailure(id, long)).toBe(true);
    expect(store.resolveFailure(id, "B.md")).toBe(true);
    expect(store.snapshot().records[0]).toMatchObject({ state: "succeeded", failed: 0, succeeded: 2 });
    store.dispose();
  });

  it("retains useful diagnostics when failure recovery is no longer needed", () => {
    const { store, id } = failedBatch(["A.md"]);
    const copy = { id: "copy", label: "Copy diagnostics", kind: "copy-details" as const };
    store.update(id, { recovery: [{ id: "retry", label: "Retry", kind: "retry" }, copy] });
    store.resolveFailure(id, "A.md");
    expect(store.snapshot().records[0]?.recovery).toEqual([copy]);
    store.dispose();
  });

  it("keeps unattempted work visible after the recorded failure resolves", () => {
    const { store, id } = failedBatch(["A.md"], { total: 3 });
    store.resolveFailure(id, "A.md");
    expect(store.snapshot().records[0]).toMatchObject({ state: "needs-attention", completed: 1, total: 3, failed: 0, succeeded: 1 });
    store.dispose();
  });

  it("does not resolve unknown failures, a running replacement batch, or a dismissed record", () => {
    const { store, id } = failedBatch(["A.md"]);
    expect(store.resolveFailure(id, "unknown.md")).toBe(false);
    store.start({ id, kind: "source-enrichment", title: "New batch", total: 1 });
    expect(store.resolveFailure(id, "A.md")).toBe(false);
    store.fail(id, { failed: 1 });
    expect(store.resolveFailure(id, "A.md")).toBe(false);
    store.dismiss(id);
    expect(store.resolveFailure(id, "A.md")).toBe(false);
    store.dispose();
  });
});

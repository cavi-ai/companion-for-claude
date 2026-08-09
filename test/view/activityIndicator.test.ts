import { describe, expect, it, vi } from "vitest";
import { FakeElement } from "obsidian";
import { ActivityStore } from "../../src/activity/store";
import { mountActivityIndicator } from "../../src/view/ActivityIndicator";

const element = (root: FakeElement, selector: string): FakeElement => {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
};

const buttons = (root: FakeElement): FakeElement[] => root.querySelectorAll("button");

describe("mountActivityIndicator", () => {
  it("renders one stable determinate activity with an accessible percentage", () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });

    const id = store.start({ id: "index", kind: "semantic-index", title: "Building index", total: 5 });
    store.update(id, { completed: 2, currentItem: "Research/notes.md" });

    const indicator = element(root, ".cc-activity-indicator");
    expect(indicator.getAttribute("aria-label")).toBe("Companion activity: Building index, 40%");
    expect(element(root, "[role=\"progressbar\"]").getAttribute("aria-valuenow")).toBe("40");
    expect(root.querySelectorAll("[role=\"status\"]")).toHaveLength(1);
    expect(element(root, "[role=\"status\"]").getAttribute("aria-live")).toBe("polite");
  });

  it("does not invent progress for an indeterminate download", () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });

    store.start({ kind: "embedding-download", title: "Downloading embedding model" });

    const progress = element(root, "[role=\"progressbar\"]");
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
    expect(element(root, ".cc-activity-indicator").getAttribute("aria-label"))
      .toBe("Companion activity: Downloading embedding model, in progress");
  });

  it("opens a touch-safe activity drawer with file-specific details", () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });
    const id = store.start({ id: "inbox", kind: "source-enrichment", title: "Enriching Inbox", total: 2 });
    store.update(id, {
      completed: 1,
      succeeded: 1,
      currentItem: "Inbox/clip.md",
      details: [{ label: "Inbox/clip.md", message: "Enriched", state: "success" }],
    });

    const indicator = element(root, ".cc-activity-indicator");
    expect(indicator.getAttribute("aria-expanded")).toBe("false");
    indicator.dispatchEvent({ type: "click" });

    expect(element(root, ".cc-activity-indicator").getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelectorAll(".cc-activity-drawer")).toHaveLength(1);
    expect(element(root, "summary").getAttribute("aria-label")).toBe("Activity details for Enriching Inbox");
    expect(element(root, ".cc-activity-current").textContent).toBe("Inbox/clip.md");
    expect(element(root, ".cc-activity-detail-message").textContent).toBe("Enriched");
  });

  it("surfaces recovery and dismissal actions for an activity that needs attention", async () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    const runRecovery = vi.fn().mockResolvedValue(undefined);
    const dismiss = vi.fn();
    mountActivityIndicator(root as unknown as HTMLElement, { store, runRecovery, dismiss });
    const id = store.start({ id: "index", kind: "semantic-index", title: "Building index", total: 3 });
    store.fail(id, {
      completed: 1,
      failed: 1,
      details: [{ label: "Research/broken.pdf", message: "Embedding model unavailable", state: "error" }],
      recovery: [{ id: "download-model", label: "Download model", kind: "download" }],
      technicalDetails: "Model file was not found",
    });

    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    const recovery = buttons(root).find((button) => button.textContent === "Download model");
    const dismissButton = buttons(root).find((button) => button.textContent === "Dismiss");
    expect(recovery?.getAttribute("aria-label")).toBe("Download model for Building index");
    expect(dismissButton?.getAttribute("aria-label")).toBe("Dismiss Building index activity");

    recovery?.dispatchEvent({ type: "click" });
    dismissButton?.dispatchEvent({ type: "click" });
    await Promise.resolve();

    expect(runRecovery).toHaveBeenCalledWith("index", "download-model");
    expect(dismiss).toHaveBeenCalledWith("index");
  });

  it("keeps a failed recovery actionable in-app instead of swallowing the error", async () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn().mockRejectedValue(new Error("token=supersecret endpoint is still unavailable")),
      dismiss: vi.fn(),
    });
    const id = store.start({ id: "index", kind: "semantic-index", title: "Building index" });
    store.fail(id, {
      failed: 1,
      recovery: [{ id: "retry-index", label: "Retry index", kind: "retry" }],
    });

    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    buttons(root).find((button) => button.textContent === "Retry index")?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();

    const message = store.snapshot().records[0]?.details.at(-1)?.message;
    expect(message).toContain("endpoint is still unavailable");
    expect(message).not.toContain("supersecret");
  });

  it("prioritizes needs-attention work over newer running work", () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });
    const failed = store.start({ id: "failed", kind: "semantic-index", title: "Index needs attention" });
    store.fail(failed, { failed: 1 });
    store.start({ id: "newer", kind: "source-enrichment", title: "Enriching Inbox", total: 2 });

    expect(element(root, ".cc-activity-indicator").getAttribute("aria-label"))
      .toBe("Companion activity: Index needs attention, needs attention");
  });

  it("unsubscribes and removes its UI on unmount", () => {
    const root = new FakeElement();
    const store = new ActivityStore();
    const unmount = mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });
    store.start({ id: "first", kind: "semantic-index", title: "First" });
    expect(root.querySelectorAll(".cc-activity-indicator")).toHaveLength(1);

    unmount();
    store.start({ id: "late", kind: "semantic-index", title: "Late" });

    expect(root.querySelectorAll(".cc-activity-indicator")).toHaveLength(0);
    expect(root.children).toHaveLength(0);
  });
});

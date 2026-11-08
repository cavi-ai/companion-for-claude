import { describe, expect, it, vi } from "vitest";
import { FakeElement, fakeDocument } from "obsidian";
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
    const root = new FakeElement(); root.addClass("cc-root");
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });

    const id = store.start({ id: "index", kind: "semantic-index", title: "Building index", total: 5 });
    store.update(id, { completed: 2, currentItem: "Research/notes.md" });

    const indicator = element(root, ".cc-activity-indicator");
    expect(indicator.getAttribute("aria-label")).toBe("Activity: 1 task, 40% complete");
    expect(element(root, "[role=\"progressbar\"]").getAttribute("aria-valuenow")).toBe("40");
    expect(root.querySelectorAll("[role=\"status\"]")).toHaveLength(1);
    expect(element(root, "[role=\"status\"]").getAttribute("aria-live")).toBe("polite");
  });

  it("does not invent progress for an indeterminate download", () => {
    const root = new FakeElement(); root.addClass("cc-root");
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
      .toBe("Activity: 1 task, In progress");
  });

  it("opens a touch-safe activity drawer with file-specific details", () => {
    const root = new FakeElement(); root.addClass("cc-root");
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

  it("preserves keyboard focus when toggling the labelled activity details region", () => {
    const root = new FakeElement(); root.addClass("cc-root");
    const store = new ActivityStore();
    mountActivityIndicator(root as unknown as HTMLElement, {
      store,
      runRecovery: vi.fn(),
      dismiss: vi.fn(),
    });
    store.start({ id: "index", kind: "semantic-index", title: "Building index" });

    const indicator = element(root, ".cc-activity-indicator");
    indicator.focus();
    indicator.dispatchEvent({ type: "click" });

    expect(element(root, ".cc-activity-indicator").getAttribute("data-focused")).toBe("true");
    expect(element(root, ".cc-activity-drawer").getAttribute("role")).toBe("region");
    vi.unstubAllGlobals();
  });

  it("surfaces recovery and dismissal actions for an activity that needs attention", async () => {
    const root = new FakeElement(); root.addClass("cc-root");
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
    const root = new FakeElement(); root.addClass("cc-root");
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
    const root = new FakeElement(); root.addClass("cc-root");
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
      .toBe("Activity: 2 tasks, Needs attention");
  });

  it("unsubscribes and removes its UI on unmount", () => {
    const root = new FakeElement(); root.addClass("cc-root");
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
  it("closes details without dismissing records and supports Escape", () => {
    const root = new FakeElement(); root.addClass("cc-root"); const store = new ActivityStore(); const dismiss = vi.fn();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss });
    store.start({ id: "work", kind: "semantic-index", title: "A long task title" });
    const trigger = element(root, ".cc-activity-indicator");
    trigger.dispatchEvent({ type: "click" });
    element(root, ".cc-pane-popover-close").dispatchEvent({ type: "click" });
    expect(root.querySelector(".cc-activity-drawer")).toBeNull();
    expect(store.snapshot().records).toHaveLength(1); expect(dismiss).not.toHaveBeenCalled();
    expect(trigger.getAttribute("data-focused")).toBe("true");
    trigger.dispatchEvent({ type: "click" });
    element(root, ".cc-activity-drawer").dispatchEvent({ type: "keydown", key: "Escape", preventDefault: vi.fn() });
    expect(root.querySelector(".cc-activity-drawer")).toBeNull();
    expect(element(root, ".cc-activity-indicator-title").textContent).toBe("Activity");
    expect(trigger.getAttribute("aria-label")).not.toContain("A long task title");
  });

  it("keeps expanded records, technical details, scroll and focused recovery across updates", () => {
    const root = new FakeElement(); root.addClass("cc-root"); const store = new ActivityStore();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: vi.fn() });
    const id = store.start({ id: "work", kind: "semantic-index", title: "Building index" });
    store.fail(id, { recovery: [{ id: "retry", label: "Retry", kind: "retry" }], technicalDetails: "Cause" });
    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    const record = element(root, ".cc-activity-record"); const technical = element(root, ".cc-activity-technical");
    (record as unknown as HTMLDetailsElement).open = true;
    (technical as unknown as HTMLDetailsElement).open = true;
    (element(root, ".cc-activity-records") as unknown as HTMLElement).scrollTop = 74;
    element(root, ".cc-activity-action").focus();
    store.update(id, { currentItem: "Next note" });
    expect((element(root, ".cc-activity-record") as unknown as HTMLDetailsElement).open).toBe(true);
    expect((element(root, ".cc-activity-technical") as unknown as HTMLDetailsElement).open).toBe(true);
    expect((element(root, ".cc-activity-records") as unknown as HTMLElement).scrollTop).toBe(74);
    expect(fakeDocument.activeElement).toBe(element(root, ".cc-activity-action"));
    store.update(id, { recovery: [] });
    expect(fakeDocument.activeElement).toBe(element(root, ".cc-activity-summary"));
  });

  it("does not move another pane's focused recovery when the shared store updates", () => {
    const first = new FakeElement(); first.addClass("cc-root");
    const second = new FakeElement(); second.addClass("cc-root");
    const store = new ActivityStore();
    mountActivityIndicator(first as never, { store, runRecovery: vi.fn(), dismiss: vi.fn() });
    mountActivityIndicator(second as never, { store, runRecovery: vi.fn(), dismiss: vi.fn() });
    const id = store.start({ id: "work", kind: "semantic-index", title: "Index" });
    store.fail(id, { recovery: [{ id: "retry", label: "Retry", kind: "retry" }] });
    element(first, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    element(second, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    element(second, ".cc-activity-action").focus();
    store.update(id, { currentItem: "Next file" });
    expect(fakeDocument.activeElement).toBe(element(second, ".cc-activity-action"));
    expect(element(first, ".cc-activity-action").getAttribute("data-focused")).toBeNull();
  });

  it("returns focus to the owning chat composer when Dismiss removes the final activity", () => {
    const root = new FakeElement(); root.addClass("cc-root"); root.addClass("cc-chat-root");
    const input = root.createEl("textarea", { cls: "cc-input" }); const store = new ActivityStore();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
    const id = store.start({ id: "last", kind: "semantic-index", title: "Index" }); store.fail(id, { failed: 1 });
    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    const dismiss = element(root, ".cc-activity-dismiss"); dismiss.focus(); dismiss.dispatchEvent({ type: "click" });
    expect(root.querySelector(".cc-activity-indicator")).toBeNull();
    expect(root.querySelector(".cc-activity-drawer")).toBeNull();
    expect(store.snapshot().records).toEqual([]); expect(fakeDocument.activeElement).toBe(input);
  });

  it("returns focus to a surviving page control outside chat", () => {
    const root = new FakeElement(); root.addClass("cc-root");
    const options = root.createEl("button", { cls: "cc-companion-quick-options" }); const store = new ActivityStore();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
    const id = store.start({ id: "last", kind: "semantic-index", title: "Index" }); store.fail(id, { failed: 1 });
    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    element(root, ".cc-activity-dismiss").focus(); store.dismiss(id);
    expect(fakeDocument.activeElement).toBe(options);
  });

  it("preserves unrelated focus when the last activity disappears", () => {
    const root = new FakeElement(); root.addClass("cc-root"); root.addClass("cc-chat-root");
    root.createEl("textarea", { cls: "cc-input" }); const other = new FakeElement("button"); const store = new ActivityStore();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
    const id = store.start({ id: "last", kind: "semantic-index", title: "Index" });
    element(root, ".cc-activity-indicator").dispatchEvent({ type: "click" }); other.focus(); store.dismiss(id);
    expect(fakeDocument.activeElement).toBe(other);
  });

  it("restores only the pane whose activity owned focus when a shared final record disappears", () => {
    const first = new FakeElement(); first.addClass("cc-root"); first.addClass("cc-chat-root");
    const firstInput = first.createEl("textarea", { cls: "cc-input" });
    const second = new FakeElement(); second.addClass("cc-root"); second.addClass("cc-chat-root");
    const secondInput = second.createEl("textarea", { cls: "cc-input" }); const store = new ActivityStore();
    for (const root of [first, second]) mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
    const id = store.start({ id: "last", kind: "semantic-index", title: "Index" }); store.fail(id, { failed: 1 });
    element(first, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    element(second, ".cc-activity-indicator").dispatchEvent({ type: "click" });
    element(second, ".cc-activity-dismiss").focus(); store.dismiss(id);
    expect(fakeDocument.activeElement).toBe(secondInput); expect(firstInput.getAttribute("data-focused")).toBeNull();
  });

  it.each(["indicator", "dismiss"])("keeps automatic completion cleanup and restores focus from its final %s", control => {
    vi.useFakeTimers();
    try {
      const root = new FakeElement(); root.addClass("cc-root"); root.addClass("cc-chat-root");
      const input = root.createEl("textarea", { cls: "cc-input" }); const store = new ActivityStore();
      const unmount = mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
      const id = store.start({ id: "last", kind: "semantic-index", title: "Index", total: 1 }); store.finish(id, { completed: 1, succeeded: 1 });
      const indicator = element(root, ".cc-activity-indicator");
      if (control === "dismiss") { indicator.dispatchEvent({ type: "click" }); element(root, ".cc-activity-dismiss").focus(); }
      else indicator.focus();
      vi.advanceTimersByTime(3999); expect(store.snapshot().records).toHaveLength(1);
      vi.advanceTimersByTime(1); expect(store.snapshot().records).toEqual([]);
      expect(fakeDocument.activeElement).toBe(input); expect(root.querySelector(".cc-activity-indicator")).toBeNull();
      unmount(); store.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("skips unavailable controls when restoring focus after the final activity", () => {
    const root = new FakeElement(); root.addClass("cc-root"); root.addClass("cc-chat-root");
    const input = root.createEl("textarea", { cls: "cc-input" }); input.disabled = true;
    const hidden = root.createEl("button", { cls: "cc-companion-quick-options" }); Object.assign(hidden, { checkVisibility: () => false });
    const control = root.createEl("button", { cls: "cc-model" }); const store = new ActivityStore();
    mountActivityIndicator(root as never, { store, runRecovery: vi.fn(), dismiss: id => store.dismiss(id) });
    const id = store.start({ id: "last", kind: "semantic-index", title: "Index" });
    element(root, ".cc-activity-indicator").focus(); store.dismiss(id);
    expect(fakeDocument.activeElement).toBe(control);
  });

});

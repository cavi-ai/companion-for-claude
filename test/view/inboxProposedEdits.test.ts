import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import type { QueuedEdit } from "../../src/orders/editQueue";
import { InboxView } from "../../src/view/InboxView";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const item = (id: string, over: Partial<QueuedEdit> = {}): QueuedEdit => ({
  id, orderId: "o.md", orderName: "Follow ups", runPath: "Claude/Orders/Follow ups/r.md", path: "Meetings/Standup.md",
  edits: [{ old_str: "a", new_str: "b" }], description: "Mark shipped", createdAt: Date.now(), ...over,
});

function harness(queue: QueuedEdit[]) {
  const app = new App();
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  const reviewQueuedEdit = vi.fn(async () => undefined);
  const discardQueuedEdit = vi.fn(async () => undefined);
  Object.assign(plugin, {
    app,
    settings: { sourceCaptureEnabled: true, sourceInboxFolder: "Clippings", clipOrganizedFolder: "Library" },
    sourceEnrichmentBackendLabel: () => "Claude",
    linkCandidates: () => [],
    clipperSetupNeeded: () => false,
    listQueuedEdits: () => queue,
    reviewQueuedEdit,
    discardQueuedEdit,
  });
  return { app, view: new InboxView(new WorkspaceLeaf(app), plugin), reviewQueuedEdit, discardQueuedEdit };
}

const root = (view: InboxView): FakeElement => view.contentEl as unknown as FakeElement;
const click = (el: FakeElement | null | undefined): void => el?.dispatchEvent({ type: "click" });

describe("Inbox proposed edits", () => {
  it("renders no section when the queue is empty", async () => {
    const { view } = harness([]);
    await view.render();
    await settle();
    expect(root(view).querySelector(".cc-inbox-orders")).toBeNull();
  });

  it("lists each queued edit with its order, description and actions", async () => {
    const { app, view, reviewQueuedEdit, discardQueuedEdit } = harness([item("r#0")]);
    app.vault.seed("Meetings/Standup.md", "a");
    await view.render();
    await settle();

    expect(root(view).querySelector(".cc-inbox-orders")?.querySelector(".cc-eyebrow")?.textContent).toBe("PROPOSED EDITS");
    const row = root(view).querySelector(".cc-inbox-order-edit");
    expect(row?.querySelector(".cc-inbox-name")?.textContent).toBe("Standup");
    expect(row?.querySelector(".cc-inbox-order-meta")?.textContent).toBe("Follow ups · just now");
    expect(row?.querySelector(".cc-inbox-order-description")?.textContent).toBe("Mark shipped");
    const review = row?.querySelector(".cc-inbox-order-review");
    expect(review?.textContent).toBe("Review");
    expect(review?.classList.has("mod-cta")).toBe(true);

    click(review);
    expect(reviewQueuedEdit).toHaveBeenCalledWith("r#0");
    click(row?.querySelector(".cc-inbox-order-discard"));
    expect(discardQueuedEdit).toHaveBeenCalledWith("r#0");
  });

  it("offers only Discard when the target note is missing", async () => {
    const { view } = harness([item("r#0")]);
    await view.render();
    await settle();
    const row = root(view).querySelector(".cc-inbox-order-edit");
    expect(row?.querySelector(".cc-inbox-order-missing")?.textContent).toBe("Note missing");
    expect(row?.querySelector(".cc-inbox-order-review")).toBeNull();
    expect(row?.querySelector(".cc-inbox-order-discard")).not.toBeNull();
  });
});

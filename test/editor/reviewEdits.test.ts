import { describe, expect, it, vi } from "vitest";
import { getLastOpenedModal, MarkdownView, TFile, WorkspaceLeaf, type App } from "obsidian";
import { planEdits } from "../../src/edit/diff";
import { reviewEdits, findOpenMarkdownView, editorViewOf, frontmatterEnd } from "../../src/editor/reviewEdits";

const DOC = "# Note\n\nalpha beta\n";

function openView(path: string, doc = DOC) {
  const view = new MarkdownView() as MarkdownView & { file: TFile; editor: unknown; leaf: WorkspaceLeaf };
  view.file = new TFile(path, "", 0);
  view.leaf = new WorkspaceLeaf();
  const cm = { id: "cm" };
  view.editor = { cm, getValue: () => doc };
  return { view, cm };
}

function appWith(views: MarkdownView[]): { app: App; revealed: unknown[] } {
  const revealed: unknown[] = [];
  const app = {
    workspace: {
      getLeavesOfType: () => views.map((view) => ({ view })),
      revealLeaf: (leaf: unknown) => { revealed.push(leaf); },
    },
  } as unknown as App;
  return { app, revealed };
}

const input = (path: string, doc = DOC) => ({ file: new TFile(path, "", 0), plan: planEdits(doc, [{ old_str: "beta", new_str: "gamma" }]), description: "swap" });

describe("editorViewOf", () => {
  it("returns the cm view when present and null otherwise", () => {
    const cm = {};
    expect(editorViewOf({ cm })).toBe(cm);
    expect(editorViewOf({})).toBeNull();
  });
});

describe("findOpenMarkdownView", () => {
  it("matches a markdown leaf by file path", () => {
    const { view } = openView("A.md");
    const { app } = appWith([view]);
    expect(findOpenMarkdownView(app, "A.md")).toBe(view);
    expect(findOpenMarkdownView(app, "B.md")).toBeNull();
  });
});

describe("frontmatterEnd", () => {
  it("returns the offset after the closing fence line, or -1 without frontmatter", () => {
    expect(frontmatterEnd("---\ntitle: A\n---\nbody\n")).toBe(17);
    expect(frontmatterEnd("---\r\ntitle: A\r\n---\r\nbody")).toBe(20);
    expect(frontmatterEnd("---\ntitle: A\n---")).toBe(16);
    expect(frontmatterEnd("# Note\n---\nx\n---\n")).toBe(-1);
    expect(frontmatterEnd("---\nunclosed\nbody\n")).toBe(-1);
    expect(frontmatterEnd("")).toBe(-1);
  });
});

describe("reviewEdits", () => {
  it("uses the modal for an open note when the edit touches its frontmatter", async () => {
    const doc = "---\ntitle: Old\n---\n\nbody\n";
    const { view } = openView("A.md", doc);
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [true]);
    const fm = { file: new TFile("A.md", "", 0), plan: planEdits(doc, [{ old_str: "title: Old", new_str: "title: New" }]) };
    expect(await reviewEdits(app, fm, { inlineEnabled: true }, { reviewInline, openModal })).toEqual({ mode: "modal", accepted: [true] });
    expect(reviewInline).not.toHaveBeenCalled();
  });

  it("keeps inline review for an edit below the frontmatter", async () => {
    const doc = "---\ntitle: Old\n---\n\nalpha beta\n";
    const { view } = openView("A.md", doc);
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [true]);
    const body = { file: new TFile("A.md", "", 0), plan: planEdits(doc, [{ old_str: "beta", new_str: "gamma" }]) };
    expect(await reviewEdits(app, body, { inlineEnabled: true }, { reviewInline, openModal })).toMatchObject({ mode: "inline" });
    expect(openModal).not.toHaveBeenCalled();
  });

  it("dismisses an open modal when the turn is stopped", async () => {
    const { app } = appWith([]);
    const controller = new AbortController();
    const review = reviewEdits(app, input("A.md"), { inlineEnabled: false, signal: controller.signal });
    const modal = getLastOpenedModal();
    controller.abort();
    await expect(review).resolves.toEqual({ mode: "modal", accepted: null });
    expect(modal?.closed).toBe(true);
  });

  it("cancels an inline review when the turn is stopped", async () => {
    const { view, cm } = openView("A.md");
    const { app } = appWith([view]);
    const controller = new AbortController();
    let finish!: (accepted: boolean[] | null) => void;
    const cancelInline = vi.fn(() => finish(null));
    const review = reviewEdits(app, input("A.md"), { inlineEnabled: true, signal: controller.signal }, {
      reviewInline: () => new Promise((resolve) => { finish = resolve; }),
      cancelInline,
      openModal: vi.fn(),
    });
    await Promise.resolve();
    controller.abort();
    await expect(review).resolves.toEqual({ mode: "inline", accepted: null });
    expect(cancelInline).toHaveBeenCalledWith(cm);
  });

  it("reviews inline when the note is open and inline is enabled, revealing its leaf", async () => {
    const { view, cm } = openView("A.md");
    const { app, revealed } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [true]);
    const outcome = await reviewEdits(app, input("A.md"), { inlineEnabled: true }, { reviewInline, openModal });
    expect(outcome).toEqual({ mode: "inline", accepted: [true] });
    expect(reviewInline).toHaveBeenCalledTimes(1);
    expect(reviewInline.mock.calls[0]![0]).toBe(cm);
    expect(reviewInline.mock.calls[0]![1]).toMatchObject({ path: "A.md", description: "swap", hunks: [{ oldText: "alpha beta", newText: "alpha gamma", status: "pending" }] });
    expect(revealed).toEqual([view.leaf]);
    expect(openModal).not.toHaveBeenCalled();
  });

  it("falls back to the modal when the note is not open", async () => {
    const { app } = appWith([]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [false]);
    const outcome = await reviewEdits(app, input("A.md"), { inlineEnabled: true }, { reviewInline, openModal });
    expect(outcome).toEqual({ mode: "modal", accepted: [false] });
    expect(reviewInline).not.toHaveBeenCalled();
    expect(openModal.mock.calls[0]![1]).toMatchObject({ path: "A.md", description: "swap" });
  });

  it("falls back to the modal when inline review is disabled", async () => {
    const { view } = openView("A.md");
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => null);
    expect(await reviewEdits(app, input("A.md"), { inlineEnabled: false }, { reviewInline, openModal })).toEqual({ mode: "modal", accepted: null });
    expect(reviewInline).not.toHaveBeenCalled();
  });

  it("falls back to the modal when the live buffer drifted from the plan", async () => {
    const { view } = openView("A.md", "# Note\n\nalpha BETA\n");
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [true]);
    expect(await reviewEdits(app, input("A.md"), { inlineEnabled: true }, { reviewInline, openModal })).toEqual({ mode: "modal", accepted: [true] });
    expect(reviewInline).not.toHaveBeenCalled();
  });
});

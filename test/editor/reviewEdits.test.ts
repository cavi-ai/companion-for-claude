import { describe, expect, it, vi } from "vitest";
import { getLastOpenedModal, MarkdownView, TFile, WorkspaceLeaf, type App } from "obsidian";
import { planEdits } from "../../src/edit/diff";
import { reviewEdits, findOpenMarkdownView, editorViewOf, hiddenRanges } from "../../src/editor/reviewEdits";

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

const slice = (content: string) => hiddenRanges(content).map((r) => content.slice(r.from, r.to));

describe("hiddenRanges", () => {
  it("covers leading frontmatter through its closing fence line, LF and CRLF", () => {
    expect(hiddenRanges("---\ntitle: A\n---\nbody\n")).toEqual([{ from: 0, to: 17 }]);
    expect(hiddenRanges("---\r\ntitle: A\r\n---\r\nbody")).toEqual([{ from: 0, to: 20 }]);
    expect(hiddenRanges("---\ntitle: A\n---")).toEqual([{ from: 0, to: 16 }]);
    expect(hiddenRanges("# Note\n---\nx\n---\n")).toEqual([]);
    expect(hiddenRanges("---\nunclosed\nbody\n")).toEqual([]);
    expect(hiddenRanges("")).toEqual([]);
  });

  it("covers a table run", () => {
    const doc = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n";
    expect(slice(doc)).toEqual(["| a | b |\n|---|---|\n| 1 | 2 |\n"]);
  });

  it("covers a table on the last line without a trailing newline", () => {
    const doc = "intro\n\n| a | b |";
    expect(hiddenRanges(doc)).toEqual([{ from: 7, to: doc.length }]);
  });

  it("covers a callout run but not a plain blockquote", () => {
    const doc = "> [!note] Title\n> body\n> more\n\n> plain quote\n> more\n";
    expect(slice(doc)).toEqual(["> [!note] Title\n> body\n> more\n"]);
    expect(hiddenRanges("> plain\n> quote\n")).toEqual([]);
  });

  it("covers backtick and tilde fences through the matching closer", () => {
    expect(slice("a\n```js\nx\n```\nb\n")).toEqual(["```js\nx\n```\n"]);
    expect(slice("a\n~~~\n| t |\n~~~\nb\n")).toEqual(["~~~\n| t |\n~~~\n"]);
    expect(slice("a\n````\n```\nx\n````\nb")).toEqual(["````\n```\nx\n````\n"]);
  });

  it("covers an unclosed fence to the end of the note", () => {
    const doc = "a\n```\nx\ny";
    expect(hiddenRanges(doc)).toEqual([{ from: 2, to: doc.length }]);
  });

  it("covers $$ math blocks inclusive and unclosed ones to the end", () => {
    expect(slice("a\n$$\nx^2\n$$\nb\n")).toEqual(["$$\nx^2\n$$\n"]);
    expect(slice("a\n$$x^2$$\nb\n")).toEqual(["$$x^2$$\n"]);
    const doc = "a\n$$\nx^2\n";
    expect(hiddenRanges(doc)).toEqual([{ from: 2, to: doc.length }]);
  });

  it("gives no range for inline math", () => {
    expect(hiddenRanges("so $x$ and $y$ hold\n")).toEqual([]);
  });

  it("covers an HTML block through the next blank line", () => {
    expect(slice("a\n\n<div class=\"x\">\n  hi\n</div>\n\nb\n")).toEqual(["<div class=\"x\">\n  hi\n</div>\n"]);
  });

  it("covers an embed-only line", () => {
    expect(slice("a\n![[Image.png]]\nb\n")).toEqual(["![[Image.png]]\n"]);
    expect(hiddenRanges("see ![[Image.png]] inline\n")).toEqual([]);
  });

  it("handles CRLF blocks", () => {
    const doc = "a\r\n| a | b |\r\n| 1 | 2 |\r\nb\r\n";
    expect(slice(doc)).toEqual(["| a | b |\r\n| 1 | 2 |\r\n"]);
  });
});

describe("reviewEdits", () => {
  const route = async (doc: string, oldStr: string, newStr: string, source: boolean) => {
    const { view } = openView("A.md", doc);
    (view as unknown as { getState: () => Record<string, unknown> }).getState = () => ({ source });
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const openModal = vi.fn(async () => [true]);
    const edit = { file: new TFile("A.md", "", 0), plan: planEdits(doc, [{ old_str: oldStr, new_str: newStr }]) };
    const outcome = await reviewEdits(app, edit, { inlineEnabled: true }, { reviewInline, openModal });
    return outcome.mode;
  };
  const TABLE = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n";
  const FRONTMATTER = "---\ntitle: Old\n---\n\nbody\n";
  const CALLOUT = "intro\n\n> [!note] T\n> alpha\n\nafter\n";

  it("uses the modal for a table hunk in Live Preview", async () => {
    expect(await route(TABLE, "| a | b |", "| a | c |", false)).toBe("modal");
  });

  it("reviews a table hunk inline in source mode", async () => {
    expect(await route(TABLE, "| a | b |", "| a | c |", true)).toBe("inline");
  });

  it("reviews a frontmatter hunk inline in source mode and in the modal in Live Preview", async () => {
    expect(await route(FRONTMATTER, "title: Old", "title: New", true)).toBe("inline");
    expect(await route(FRONTMATTER, "title: Old", "title: New", false)).toBe("modal");
  });

  it("reviews a plain paragraph hunk inline in Live Preview", async () => {
    expect(await route(TABLE, "intro", "outro", false)).toBe("inline");
    expect(await route(FRONTMATTER, "body", "text", false)).toBe("inline");
  });

  it("uses the modal for a callout hunk in Live Preview", async () => {
    expect(await route(CALLOUT, "alpha", "beta", false)).toBe("modal");
  });

  it("reviews inline when the view reports no state", async () => {
    const { view } = openView("A.md", TABLE);
    const { app } = appWith([view]);
    const reviewInline = vi.fn(async () => [true]);
    const edit = { file: new TFile("A.md", "", 0), plan: planEdits(TABLE, [{ old_str: "intro", new_str: "outro" }]) };
    expect(await reviewEdits(app, edit, { inlineEnabled: true }, { reviewInline, openModal: vi.fn() })).toMatchObject({ mode: "inline" });
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

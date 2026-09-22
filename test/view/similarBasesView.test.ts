import { describe, expect, it, vi } from "vitest";
import { App, NullValue, TFile } from "obsidian";
import { SimilarBasesView } from "../../src/view/SimilarBasesView";
import { FakeElement } from "../fakes/obsidian";

type RelatedFn = (p: string, k: number, accept?: (path: string) => boolean) => Promise<{ path: string; score: number }[]>;

function entry(path: string, status: string | unknown) {
  const file = new TFile(path, "", 0);
  return { file, getValue: (p: string) => (p === "note.status" ? (typeof status === "string" ? { toString: () => status } : status) : null) };
}

function makeView(opts: { active: string | null; related: RelatedFn; semantic?: boolean }) {
  const el = new FakeElement("div");
  const view = new SimilarBasesView({} as never, el as never, { semanticEnabled: () => opts.semantic ?? true, related: opts.related });
  const app = new App();
  const openLinkText = vi.fn();
  Object.assign(app.workspace, { getActiveFile: () => (opts.active ? { path: opts.active } : null), openLinkText, on: () => ({}) });
  view.app = app as never;
  view.config = { get: (k: string) => (k === "limit" ? 2 : undefined), getOrder: () => ["note.status"], getDisplayName: () => "Status" };
  view.data = { data: [entry("A.md", "open"), entry("B.md", "done"), entry("C.md", "open"), entry("D.md", "open")] } as never;
  return { view, el, openLinkText };
}

describe("SimilarBasesView", () => {
  it("renders base members ranked by similarity with percent and ordered properties, capped by the limit option", async () => {
    const { view, el, openLinkText } = makeView({ active: "A.md", related: async () => [{ path: "C.md", score: 0.91 }, { path: "Out.md", score: 0.9 }, { path: "B.md", score: 0.5 }, { path: "D.md", score: 0.4 }] });
    await view.refresh();
    const rows = el.querySelectorAll(".cc-similar-row");
    expect(rows.map((r) => r.querySelector(".cc-similar-link")?.textContent)).toEqual(["C", "B"]);
    expect(rows[0]?.querySelector(".cc-similar-score")?.textContent).toBe("91%");
    expect(rows[0]?.querySelector(".cc-similar-prop")?.textContent).toBe("Status: open");
    rows[0]?.querySelector(".cc-similar-link")?.dispatchEvent({ type: "click", preventDefault() {} });
    expect(openLinkText).toHaveBeenCalledWith("C.md", "A.md");
  });

  it("asks for a note when the active file is the .base itself", async () => {
    const related = vi.fn(async () => []);
    const { view, el } = makeView({ active: "Books.base", related });
    await view.refresh();
    expect(el.querySelector(".cc-similar-empty")?.textContent).toContain("Open a note");
    expect(related).not.toHaveBeenCalled();
  });

  it("shows the semantic-off state without calling related", async () => {
    const related = vi.fn(async () => []);
    const { view, el } = makeView({ active: "A.md", related, semantic: false });
    await view.refresh();
    expect(el.querySelector(".cc-similar-empty")?.textContent).toContain("Turn on semantic search");
    expect(related).not.toHaveBeenCalled();
  });

  it("drops a stale result when a newer refresh started first", async () => {
    let releaseFirst: (v: { path: string; score: number }[]) => void = () => {};
    const calls: string[] = [];
    let active = "A.md";
    const related = vi.fn((p: string) => {
      calls.push(p);
      return p === "A.md" ? new Promise<{ path: string; score: number }[]>((r) => { releaseFirst = r; }) : Promise.resolve([{ path: "D.md", score: 0.6 }]);
    });
    const { view, el } = makeView({ active: "A.md", related });
    Object.assign(view.app.workspace, { getActiveFile: () => ({ path: active }) });
    const first = view.refresh();
    active = "B.md";
    await view.refresh();
    releaseFirst([{ path: "C.md", score: 0.9 }]);
    await first;
    expect(calls).toEqual(["A.md", "B.md"]);
    expect(el.querySelectorAll(".cc-similar-link").map((l) => l.textContent)).toEqual(["D"]);
  });

  it("keeps ranking the last note's neighbours when the base tab itself becomes active", async () => {
    const calls: string[] = [];
    let active = "A.md";
    const related = vi.fn(async (p: string) => { calls.push(p); return [{ path: "B.md", score: 0.9 }]; });
    const { view, el } = makeView({ active: "A.md", related });
    Object.assign(view.app.workspace, { getActiveFile: () => (active ? { path: active } : null) });
    await view.refresh();
    active = "Books.base";
    await view.refresh();
    expect(calls).toEqual(["A.md", "A.md"]);
    expect(el.querySelectorAll(".cc-similar-link").map((l) => l.textContent)).toEqual(["B"]);
  });

  it("follows the anchor note when it is renamed", async () => {
    const calls: string[] = [];
    let active = "A.md";
    const related = vi.fn(async (p: string) => { calls.push(p); return [{ path: "B.md", score: 0.9 }]; });
    const { view } = makeView({ active: "A.md", related });
    Object.assign(view.app.workspace, { getActiveFile: () => ({ path: active }) });
    view.onload();
    await view.refresh();
    active = "Books.base";
    view.app.vault.trigger("rename", { path: "Notes/A2.md" }, "A.md");
    await view.refresh();
    expect(calls.at(-1)).toBe("Notes/A2.md");
  });

  it("drops the anchor when the anchor note is deleted", async () => {
    let active = "A.md";
    const related = vi.fn(async () => [{ path: "B.md", score: 0.9 }]);
    const { view, el } = makeView({ active: "A.md", related });
    Object.assign(view.app.workspace, { getActiveFile: () => ({ path: active }) });
    view.onload();
    await view.refresh();
    active = "Books.base";
    view.app.vault.trigger("delete", { path: "A.md" });
    await view.refresh();
    expect(el.querySelector(".cc-similar-empty")?.textContent).toContain("Open a note");
  });

  it("asks related() for base members only, rejecting the anchor and out-of-base hits", async () => {
    const related = vi.fn(async () => [{ path: "C.md", score: 0.9 }]);
    const { view } = makeView({ active: "A.md", related });
    await view.refresh();
    expect(related).toHaveBeenCalledWith("A.md", 3, expect.any(Function));
    const accept = related.mock.calls[0]?.[2] as (p: string) => boolean;
    expect(accept("Out.md")).toBe(false);
    expect(accept("A.md")).toBe(false);
    expect(accept("C.md")).toBe(true);
  });

  it("renders the no-neighbours state and does not reject when related() rejects", async () => {
    const related = vi.fn(async () => { throw new Error("boom"); });
    const { view, el } = makeView({ active: "A.md", related });
    await expect(view.refresh()).resolves.toBeUndefined();
    expect(el.querySelector(".cc-similar-empty")?.textContent).toContain("No neighbours yet");
  });

  it("skips a property whose value is a NullValue", async () => {
    const related = vi.fn(async () => [{ path: "B.md", score: 0.9 }]);
    const { view, el } = makeView({ active: "A.md", related });
    view.data = { data: [entry("A.md", "open"), entry("B.md", new NullValue())] } as never;
    await view.refresh();
    const rows = el.querySelectorAll(".cc-similar-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".cc-similar-prop")).toBeNull();
  });
});

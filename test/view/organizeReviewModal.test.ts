import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { OrganizeReviewModal } from "../../src/view/OrganizeReviewModal";
import type { OrganizeMove } from "../../src/sources/organize";

const moves: OrganizeMove[] = [
  { from: "Clippings/a.md", to: "Library/ai-research/a.md", title: "a", domain: "ai-research" },
  { from: "Clippings/b.md", to: "Library/ai-research/b.md", title: "b", domain: "ai-research" },
  { from: "Clippings/c.md", to: "Library/misc/c.md", title: "c", domain: "misc" },
];

describe("OrganizeReviewModal", () => {
  it("groups rows under a heading per destination folder with a count", () => {
    const modal = new OrganizeReviewModal(new App(), moves, 0, () => {});
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const headings = root.querySelectorAll(".cc-organize-group-heading").map((h) => h.textContent);
    expect(headings).toEqual(["ai-research (2)", "misc (1)"]);
  });

  it("unchecks misc rows by default and keeps everything else checked", () => {
    const modal = new OrganizeReviewModal(new App(), moves, 0, () => {});
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const checkboxes = root.querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
    expect(checkboxes.map((c) => c.checked)).toEqual([true, true, false]);
  });

  it("renders the unresolved line only when there are unresolved candidates", () => {
    const withUnresolved = new OrganizeReviewModal(new App(), moves, 3, () => {});
    withUnresolved.onOpen();
    const root1 = withUnresolved.contentEl as unknown as FakeElement;
    expect(root1.querySelector(".cc-organize-unresolved")?.textContent).toBe(
      "3 clips could not be classified and are not in this plan.",
    );

    const noneUnresolved = new OrganizeReviewModal(new App(), moves, 0, () => {});
    noneUnresolved.onOpen();
    const root2 = noneUnresolved.contentEl as unknown as FakeElement;
    expect(root2.querySelector(".cc-organize-unresolved")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { App, FakeElement } from "obsidian";
import { BatchDiffModal } from "../src/view/BatchDiffModal";
import type { BatchLinkPlan } from "../src/links/batch";

const plans: BatchLinkPlan[] = [
  {
    path: "Inbox/alpha.md",
    basename: "alpha",
    original: "Alpha",
    plan: { hunks: [
      { start: 0, oldText: "Alpha", newText: "[[Alpha]]", lines: [{ kind: "del", text: "Alpha" }, { kind: "add", text: "[[Alpha]]" }], lineno: 1 },
      { start: 6, oldText: "Beta", newText: "[[Beta]]", lines: [], lineno: 2 },
    ] },
  },
  {
    path: "Inbox/beta.md",
    basename: "beta",
    original: "Gamma",
    plan: { hunks: [
      { start: 0, oldText: "Gamma", newText: "[[Gamma]]", lines: [], lineno: 1 },
    ] },
  },
];

describe("BatchDiffModal", () => {
  it("catches a regression that exposes every file's diff before the user expands it", () => {
    const modal = new BatchDiffModal(new App(), plans, () => undefined);
    modal.open();
    const content = modal.contentEl as unknown as FakeElement;
    const files = content.querySelectorAll("details");

    expect(files).toHaveLength(2);
    expect(files.every((file) => file.getAttribute("open") === null)).toBe(true);
    expect(files.map((file) => file.querySelector("summary")?.getAttribute("aria-label"))).toEqual([
      "Review changes in Inbox/alpha.md",
      "Review changes in Inbox/beta.md",
    ]);
    expect(files[0]?.querySelectorAll("input")).toHaveLength(2);
    expect(content.querySelectorAll(".cc-batch-diff-file-checkbox")).toHaveLength(2);
    expect(content.querySelectorAll(".cc-diff-line").map((line) => line.textContent)).toEqual(["- Alpha", "+ [[Alpha]]"]);
  });

  it("catches a regression that applies batch selections without an explicit user action", () => {
    let result: boolean[][] | null | undefined;
    const modal = new BatchDiffModal(new App(), plans, (selection) => { result = selection; });
    modal.open();

    modal.close();

    expect(result).toBeNull();
  });

  it("catches a regression that loses selected hunks after a file-level toggle", () => {
    let result: boolean[][] | null | undefined;
    const modal = new BatchDiffModal(new App(), plans, (selection) => { result = selection; });
    modal.open();
    const content = modal.contentEl as unknown as FakeElement;
    const alpha = content.querySelectorAll(".cc-batch-diff-file-checkbox")[0] as unknown as HTMLInputElement;
    alpha.checked = false;
    alpha.dispatchEvent({ type: "change" });
    content.querySelectorAll("button").find((button) => button.textContent === "Apply selected")
      ?.dispatchEvent({ type: "click" });

    expect(result).toEqual([[false, false], [true]]);
  });

  it("catches a regression that leaves the file toggle too small or inside its accordion", () => {
    const modal = new BatchDiffModal(new App(), plans, () => undefined);
    modal.open();
    const content = modal.contentEl as unknown as FakeElement;
    const fileToggle = content.querySelectorAll(".cc-batch-diff-file-toggle")[0];
    const fileCheckbox = content.querySelectorAll(".cc-batch-diff-file-checkbox")[0] as unknown as HTMLInputElement;
    const details = content.querySelectorAll("details")[0];

    expect(fileToggle?.tagName).toBe("LABEL");
    expect(fileToggle?.querySelectorAll(".cc-batch-diff-file-checkbox")).toHaveLength(1);
    expect(details?.querySelectorAll(".cc-batch-diff-file-checkbox")).toHaveLength(0);
    fileCheckbox.checked = false;
    fileCheckbox.dispatchEvent({ type: "change" });
    expect(details?.getAttribute("open")).toBeNull();
  });
});

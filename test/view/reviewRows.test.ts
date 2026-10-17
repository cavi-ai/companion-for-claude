import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { LinkProposal } from "../../src/optimize/linkScan";
import type { MergeCandidate } from "../../src/optimize/tagScan";
import type { TypeProposal, TypeScanReport } from "../../src/optimize/typeScan";
import { LinkWeaveModal } from "../../src/view/LinkWeaveModal";
import { OptimizeBrainModal } from "../../src/view/OptimizeBrainModal";
import { TypeWeaveModal } from "../../src/view/TypeWeaveModal";

// At phone width Obsidian stacks a modal's setting row and stretches every input in it, unless the row holds a toggle.
const reviewRows = (root: FakeElement): FakeElement[] =>
  root.querySelectorAll(".setting-item").filter((row) => (row.querySelector(".setting-item-name")?.textContent ?? "") !== "");
const bareCheckboxes = (root: FakeElement): FakeElement[] =>
  root.querySelectorAll("input").filter((input) =>
    (input.type === "checkbox" || input.getAttribute("type") === "checkbox") && !input.parent?.classList.has("checkbox-container"));

const expectToggleRows = (root: FakeElement, count: number): void => {
  const rows = reviewRows(root);
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row.classList.has("mod-toggle")).toBe(true);
    expect(row.querySelectorAll(".checkbox-container")).toHaveLength(1);
  }
  expect(bareCheckboxes(root)).toEqual([]);
};

const classifierInfo = async (): Promise<{ label: string; model: string }> => ({ label: "Ollama", model: "qwen3:1.7b" });

describe("review rows", () => {
  it("tag merge rows are toggle rows", () => {
    const candidates: MergeCandidate[] = [
      { id: "llm|llms", from: "llms", to: "llm", evidence: ["plural"], score: 1, fromCount: 2, toCount: 9 },
      { id: "kube|kubes", from: "kubes", to: "kube", evidence: ["plural-loose"], score: 0.7, fromCount: 1, toCount: 4 },
    ];
    const modal = new OptimizeBrainModal(new App(), candidates, {
      apply: vi.fn(), dismiss: vi.fn(), classify: vi.fn(), rescan: vi.fn(), classifierInfo,
    }, vi.fn());
    modal.onOpen();
    expectToggleRows(modal.contentEl as unknown as FakeElement, 2);
  });

  it("link weave rows are toggle rows", () => {
    const proposal: LinkProposal = {
      id: "related\u0000o.md\u0000b.md", kind: "related", orphan: "o.md", source: "o.md", target: "b.md", linktext: "b", checked: false, score: 0.82,
    };
    const modal = new LinkWeaveModal(new App(), { groups: [{ path: "o.md", proposals: [proposal] }], remaining: 0 }, {
      apply: vi.fn(), dismiss: vi.fn(),
    }, vi.fn());
    modal.onOpen();
    expectToggleRows(modal.contentEl as unknown as FakeElement, 1);
  });

  it("type weave rows are toggle rows", () => {
    const proposal: TypeProposal = {
      path: "a.md", type: "project", evidence: [{ kind: "folder", text: "folder: 3 of 3 typed notes in P/ are project" }],
      checked: true, issues: [], check: () => [], mtime: 1,
    };
    const report: TypeScanReport = { status: "ok", proposable: ["person", "project"], candidates: 1, proposals: [proposal], notShown: 0, noProposal: 0, pending: [] };
    const modal = new TypeWeaveModal(new App(), report, {
      apply: vi.fn(), dismiss: vi.fn(), classify: vi.fn(), rescan: vi.fn(), classifierInfo,
    }, vi.fn());
    modal.onOpen();
    expectToggleRows(modal.contentEl as unknown as FakeElement, 1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { renderManagedDocument } from "../../src/research/draftSections";
import { provenanceRows } from "../../src/research/provenanceView";
import { renderProvenanceReferences } from "../../src/view/research/provenanceReferences";
import { FakeElement } from "obsidian";

const doc = renderManagedDocument("", [
  { envelope: { id: "a", claimPaths: ["R/Claims/A.md"], evidence: [{ path: "R/Evidence/E.md", fingerprint: "f" }], citations: [{ key: "smith", sourcePath: "R/Sources/Smith 2025.md" }], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, heading: "Claim A", markdown: "A [@smith]." },
  { envelope: { id: "b", claimPaths: ["R/Claims/B.md"], evidence: [], citations: [], provider: "anthropic", model: "claude-sonnet-5-5", generatedAt: "2026-10-01T10:00:00.000Z" }, heading: "Claim B", markdown: "B." },
]);
const json = doc.split("```claude-provenance\n")[1]!.split("\n```")[0]!;

describe("claude-provenance references", () => {
  it("summarizes each section", () => {
    expect(provenanceRows(json)).toEqual({
      issues: [],
      rows: [
        { heading: "Claim A", citations: [{ key: "smith", sourcePath: "R/Sources/Smith 2025.md", sourceTitle: "Smith 2025" }], passages: 1, status: "Outline" },
        { heading: "Claim B", citations: [], passages: 0, status: "Drafted · claude-sonnet-5-5 · 2026-10-01" },
      ],
    });
  });

  it("renders links that open the source note", () => {
    const el = new FakeElement() as unknown as HTMLElement;
    const open = vi.fn();
    renderProvenanceReferences(el, json, open);
    const link = el.querySelectorAll("a")[0] as unknown as FakeElement;
    expect(link.textContent).toBe("[@smith] Smith 2025");
    link.dispatchEvent({ type: "click", preventDefault() {} } as never);
    expect(open).toHaveBeenCalledWith("R/Sources/Smith 2025.md");
  });

  it("renders unreadable", () => {
    const el = new FakeElement() as unknown as HTMLElement;
    renderProvenanceReferences(el, "{nope", vi.fn());
    expect((el.querySelectorAll(".cc-provenance-error") as unknown as FakeElement[])[0]?.textContent).toBe("Provenance unreadable");
  });
});

import { describe, it, expect } from "vitest";
import { WORKFLOWS } from "../src/workflows/catalog";

describe("workflow catalog", () => {
  it("has unique ids and non-empty, self-contained prompts", () => {
    const seen = new Set<string>();
    for (const w of WORKFLOWS) {
      expect(seen.has(w.id), w.id).toBe(false);
      seen.add(w.id);
      expect(w.name.length).toBeGreaterThan(0);
      expect(w.description.length).toBeGreaterThan(0);
      expect(w.prompt.length).toBeGreaterThan(20);
    }
  });

  it("brings over the manifest personas + key synthesis workflows", () => {
    const ids = new Set(WORKFLOWS.map((w) => w.id));
    for (const id of ["manifest-pm", "manifest-vault", "manifest-content", "manifest-research", "manifest-risk", "manifest-feature", "manifest-infra", "daily-rollup", "moc-builder", "source-digest"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("grounds every workflow with vault search", () => {
    expect(WORKFLOWS.every((w) => w.vaultSearch)).toBe(true);
  });
});

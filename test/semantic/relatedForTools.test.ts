import { describe, expect, it, vi } from "vitest";
import { SemanticController } from "../../src/semantic/controller";

describe("SemanticController.relatedForTools", () => {
  it("returns nothing when answering would need a model download", async () => {
    const ctrl = new SemanticController({} as never);
    vi.spyOn(ctrl, "canEmbedWithoutDownload").mockResolvedValue(false);
    const related = vi.spyOn(ctrl, "relatedNotes");
    expect(await ctrl.relatedForTools("A.md", 5)).toEqual([]);
    expect(related).not.toHaveBeenCalled();
  });

  it("delegates to relatedNotes otherwise", async () => {
    const ctrl = new SemanticController({} as never);
    vi.spyOn(ctrl, "canEmbedWithoutDownload").mockResolvedValue(true);
    vi.spyOn(ctrl, "relatedNotes").mockResolvedValue([{ path: "B.md", score: 0.9 }]);
    expect(await ctrl.relatedForTools("A.md", 5)).toEqual([{ path: "B.md", score: 0.9 }]);
  });
});

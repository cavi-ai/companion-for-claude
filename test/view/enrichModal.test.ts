import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { EnrichReviewModal } from "../../src/view/EnrichModal";

const collect = (e: FakeElement): string => [e.textContent, ...e.children.map(collect)].join("\n");
const texts = (modal: { contentEl: unknown }): string =>
  collect(modal.contentEl as FakeElement);

describe("EnrichReviewModal", () => {
  it("marks added tags that are new to the vault on the +tags line", () => {
    const modal = new EnrichReviewModal(
      new App(),
      {
        path: "N.md",
        frontmatter: { tags: ["llm", "brand-new"], summary: "", addedTags: ["llm", "brand-new"], newTags: ["brand-new"] },
      },
      () => undefined,
    );
    modal.onOpen();
    expect(texts(modal)).toContain("+tags: llm, brand-new (new)");
  });
});

import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { FrontmatterModal } from "../../src/view/FrontmatterModal";

const collect = (e: FakeElement): string => [e.textContent, ...e.children.map(collect)].join("\n");
const texts = (modal: { contentEl: unknown }): string =>
  collect(modal.contentEl as FakeElement);

describe("FrontmatterModal", () => {
  it("marks tags new to the vault in the tags row", () => {
    const modal = new FrontmatterModal(new App(), "Note", { tags: ["llm", "brand-new"], newTags: ["brand-new"] }, "local", () => undefined);
    modal.onOpen();
    expect(texts(modal)).toContain("llm, brand-new (new)");
  });

  it("shows plain tags when no new tags are given", () => {
    const modal = new FrontmatterModal(new App(), "Note", { tags: ["llm"] }, "local", () => undefined);
    modal.onOpen();
    expect(texts(modal)).not.toContain("(new)");
  });
});

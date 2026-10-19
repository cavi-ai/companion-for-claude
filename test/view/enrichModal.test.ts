import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { EnrichOptionsModal, EnrichReviewModal } from "../../src/view/EnrichModal";

const collect = (e: FakeElement): string => [e.textContent, ...e.children.map(collect)].join("\n");
const texts = (modal: { contentEl: unknown }): string =>
  collect(modal.contentEl as FakeElement);

describe("EnrichOptionsModal", () => {
  it("names every switch and exposes its current value", () => {
    const modal = new EnrichOptionsModal(new App(), 1, () => undefined);
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const switches = root.querySelectorAll('[role="switch"]');
    expect(switches.map((el) => el.getAttribute("aria-label"))).toEqual(["Rename note", "Tags & summary", "Add wikilinks", "Lint note"]);
    expect(switches.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "true"]);
    for (const control of switches) {
      expect(control.getAttribute("aria-description")).toBeTruthy();
      const input = control.querySelector("input")!;
      expect(input.getAttribute("aria-hidden")).toBe("true");
      input.dispatchEvent({ type: "change" });
      expect(control.getAttribute("aria-checked")).toBe("false");
    }
  });
});

describe("EnrichReviewModal", () => {
  it("labels rename and metadata choices with their visible details", () => {
    const modal = new EnrichReviewModal(new App(), {
      path: "N.md", rename: { from: "N.md", to: "Garden notes.md" },
      frontmatter: { tags: ["gardening"], summary: "A summary.", addedTags: ["gardening"], newTags: [] },
    }, () => undefined);
    modal.onOpen();
    const labels = (modal.contentEl as unknown as FakeElement).querySelectorAll("label");
    expect(labels).toHaveLength(2);
    for (const label of labels) expect(label.querySelector("input")).not.toBeNull();
    expect(collect(labels[0]!)).toContain("Rename");
    expect(collect(labels[0]!)).toContain("Garden notes.md");
    expect(collect(labels[1]!)).toContain("Frontmatter");
    expect(collect(labels[1]!)).toContain("gardening");
    expect(collect(labels[1]!)).toContain("A summary.");
  });

  it("shows failed steps beside the available proposals", () => {
    const modal = new EnrichReviewModal(new App(), {
      path: "N.md",
      rename: { from: "N.md", to: "New.md" },
      failures: [{ step: "Lint note", message: "Service unavailable." }],
    }, () => undefined);
    modal.onOpen();
    expect(texts(modal)).toContain("Some Tidy steps failed");
    expect(texts(modal)).toContain("Lint note: Service unavailable.");
    expect(texts(modal)).toContain("New.md");
    expect((modal.contentEl as unknown as FakeElement).querySelector('[role="alert"]')).not.toBeNull();
  });

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

import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { EvidenceExtractModal, type NewPassage, type PassageLoad } from "../../src/view/research/evidenceExtractModal";
import type { ResearchSourceRecord } from "../../src/research/types";

const sources: ResearchSourceRecord[] = ["A", "B"].map((title) => ({ title, path: `${title}.md`, project: "Project.md", type: "research-source", sourceKind: "vault" }));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(load: (source: string) => Promise<PassageLoad> = async () => ({ kind: "none" }), create = vi.fn(async (_passage: NewPassage) => undefined)) {
  const modal = new EvidenceExtractModal(new WorkspaceLeaf().app, { sources, initialSource: "A.md", load, create, changed: async () => undefined });
  modal.open();
  const field = (label: string, root = modal.contentEl) => ["input", "select", "textarea"].flatMap((tag) => [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(tag)]).find((el) => el.getAttribute("aria-label") === label)!;
  const type = (label: string, value: string, root = modal.contentEl) => { const el = field(label, root); el.value = value; el.dispatchEvent({ type: label === "Source" || label === "Where it is: type" ? "change" : "input" } as never); };
  const click = (text: string) => [...modal.contentEl.querySelectorAll("button")].find((el) => el.textContent === text)!.dispatchEvent({ type: "click" } as never);
  const select = async (source: string) => { type("Source", source); await settle(); };
  return { modal, field, type, click, select, create };
}

describe("source-owned passage work", () => {
  it("keeps manual drafts with their sources and saves both without mixing attribution", async () => {
    const { modal, field, type, click, select, create } = setup();
    await settle();
    type("Your passage", "Passage from A");
    type("Passage title", "A title");
    type("Where it is: type", "section");
    type("Where it is: value", "Methods");
    await select("B.md");
    expect(field("Your passage").value).toBe("");
    expect(field("Where it is: value").value).toBe("");
    type("Your passage", "Passage from B");
    await select("A.md");
    expect(field("Your passage").value).toBe("Passage from A");
    expect(field("Passage title").value).toBe("A title");
    expect(field("Where it is: type").value).toBe("section");
    expect(field("Where it is: value").value).toBe("Methods");
    click("Add 1 passage");
    await settle();
    expect(create).toHaveBeenCalledExactlyOnceWith({ source: "A.md", title: "A title", excerpt: "Passage from A", locatorKind: "section", locatorValue: "Methods", reviewState: "reviewed" });
    expect(modal.closed).toBe(false);
    await select("B.md");
    expect(field("Your passage").value).toBe("Passage from B");
    click("Add 1 passage");
    await settle();
    expect(create.mock.calls[1]?.[0]).toMatchObject({ source: "B.md", excerpt: "Passage from B", reviewState: "proposed" });
    expect(modal.closed).toBe(true);
  });

  it("retains candidate corrections and unchecked choices without loading the source again", async () => {
    const load = vi.fn(async (source: string): Promise<PassageLoad> => ({ kind: "passages", passages: [{ title: source, excerpt: `Text from ${source}`, locatorKind: "paragraph", locatorValue: "1", interpretation: "Original" }] }));
    const { modal, field, type, select } = setup(load);
    await settle();
    const card = modal.contentEl.querySelector<HTMLElement>(".cc-research-passage-card")!;
    type("Passage title", "A correction", card);
    type("Where it is: value", "3", card);
    type("What this passage shows", "A caveat", card);
    const check = field("Add A.md", card) as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent({ type: "change" } as never);
    await select("B.md");
    await select("A.md");
    expect(field("Passage title").value).toBe("A correction");
    expect(field("Where it is: value").value).toBe("3");
    expect(field("What this passage shows").value).toBe("A caveat");
    expect((field("Add A.md") as HTMLInputElement).checked).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a late source read in its own workspace", async () => {
    let finish!: (result: PassageLoad) => void;
    const load = vi.fn((source: string): Promise<PassageLoad> => source === "A.md" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ kind: "none" }));
    const { modal, field, type, select } = setup(load);
    await select("B.md");
    type("Your passage", "B stays here");
    finish({ kind: "passages", passages: [{ title: "A result", excerpt: "A text", locatorKind: "page", locatorValue: "4" }] });
    await settle();
    expect(field("Your passage").value).toBe("B stays here");
    expect(modal.contentEl.querySelectorAll("blockquote")).toHaveLength(0);
    await select("A.md");
    expect(modal.contentEl.querySelector("blockquote")?.textContent).toBe("A text");
    expect(field("Your passage").value).toBe("");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("locks the form during a save, ignores duplicate submissions and restores it after a failure", async () => {
    let fail!: (error: Error) => void;
    const create = vi.fn((_passage: NewPassage) => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const { modal, field, type, click } = setup(undefined, create);
    await settle();
    type("Your passage", "A retained passage");
    click("Add 1 passage");
    click("Add 1 passage");
    expect(create).toHaveBeenCalledTimes(1);
    expect(field("Source").disabled).toBe(true);
    expect(field("Your passage").disabled).toBe(true);
    fail(new Error("Write failed"));
    await settle();
    expect(modal.closed).toBe(false);
    expect(field("Source").disabled).toBe(false);
    expect(field("Your passage").disabled).toBe(false);
    expect(field("Your passage").value).toBe("A retained passage");
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("Write failed");
  });

  it("retries a failed source read without replacing a manual draft", async () => {
    let attempts = 0;
    const load = vi.fn(async (): Promise<PassageLoad> => ++attempts === 1 ? { kind: "failed", reason: "Service unavailable" } : { kind: "passages", passages: [{ title: "Recovered", excerpt: "Recovered quote", locatorKind: "page", locatorValue: "2" }] });
    const { modal, field, type, click } = setup(load);
    await settle();
    type("Your passage", "Keep this manual draft");
    click("Try reading again");
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(field("Your passage").value).toBe("Keep this manual draft");
    expect(modal.contentEl.querySelector("blockquote")?.textContent).toBe("Recovered quote");
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toBe("");
  });

  it.each(["manual", "suggestion"] as const)("allows choosing the %s copy when a manual passage matches a selected suggestion", async (keep) => {
    const { modal, field, type, click, create } = setup(async () => ({ kind: "passages", passages: [{ title: "Suggestion", excerpt: "The study said “it works”.", locatorKind: "page", locatorValue: "1" }] }));
    await settle();
    type("Your passage", 'The study  said "it works".');
    const add = [...modal.contentEl.querySelectorAll("button")].find((el) => el.textContent === "Add 2 passages")!;
    expect(add.disabled).toBe(true);
    expect(modal.contentEl.querySelector(".cc-research-duplicate-passage")?.textContent).toContain("matches a selected suggestion");
    click("Add 2 passages");
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(field("Your passage").value).toBe('The study  said "it works".');
    if (keep === "manual") {
      const check = field("Add Suggestion") as HTMLInputElement;
      check.checked = false;
      check.dispatchEvent({ type: "change" } as never);
    } else type("Your passage", "");
    click("Add 1 passage");
    await settle();
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "A.md", excerpt: keep === "manual" ? 'The study  said "it works".' : "The study said “it works”.", reviewState: keep === "manual" ? "proposed" : "reviewed" }));
  });
});

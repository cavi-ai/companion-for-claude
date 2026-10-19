import { describe, expect, it, vi } from "vitest";
import { getLastOpenedModal, WorkspaceLeaf } from "obsidian";
import { ResearchActions } from "../../src/view/research/actions";
import { NotePickModal, SourceCaptureModal } from "../../src/view/research/sourceCaptureModal";
import type { ResearchRepository } from "../../src/research/repository";

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("source note selection", () => {
  it.each(["close-first", "choose-first"])("does not cancel a selected note when lifecycle order is %s", async (order) => {
    const app = new WorkspaceLeaf().app;
    const file = app.vault.seed("Source.md", "Source text");
    const choose = vi.fn();
    const cancel = vi.fn();
    const picker = new NotePickModal(app, choose, cancel);
    picker.open();
    if (order === "close-first") picker.close();
    picker.onChooseItem(file);
    if (order === "choose-first") picker.close();
    await settle();
    expect(choose).toHaveBeenCalledExactlyOnceWith(file);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["created", "duplicate", "failed"] as const)("keeps the capture operation pending until a selected note returns %s", async (outcome) => {
    const app = new WorkspaceLeaf().app;
    const file = app.vault.seed("Source.md", "Source text");
    let finish!: () => void;
    const importSource = vi.fn(() => new Promise<{ kind: string; path: string }>((resolve, reject) => {
      finish = () => outcome === "failed" ? reject(new Error("The source could not be saved")) : resolve({ kind: outcome, path: "R/Sources/Source.md" });
    }));
    const changed = vi.fn(async () => undefined);
    const actions = new ResearchActions({ app, repository: { importSource } as unknown as ResearchRepository, changed, openPath: async () => undefined, selectProject: async () => undefined });
    actions.addSource("R/Project.md");
    const capture = getLastOpenedModal() as SourceCaptureModal;
    const pick = [...capture.contentEl.querySelectorAll("button")].find((el) => el.textContent === "Choose a vault note…")!;
    pick.dispatchEvent({ type: "click" } as never);
    const picker = getLastOpenedModal() as NotePickModal;
    picker.close();
    picker.onChooseItem(file);
    await settle();
    expect(capture.contentEl.querySelector(".cc-source-capture-status")?.textContent).toBe("Importing note…");
    pick.dispatchEvent({ type: "click" } as never);
    expect(getLastOpenedModal()).toBe(picker);
    expect(importSource).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    const message = outcome === "created" ? "Imported note: Source" : outcome === "duplicate" ? "Already in the library: Source" : "Couldn’t import Source: The source could not be saved";
    expect(capture.contentEl.querySelector(".cc-source-capture-status")?.textContent).toBe(message);
    expect(changed).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
  });

  it("returns to capture after cancelling the picker without importing anything", async () => {
    const app = new WorkspaceLeaf().app;
    const importSource = vi.fn();
    const actions = new ResearchActions({ app, repository: { importSource } as unknown as ResearchRepository, changed: async () => undefined, openPath: async () => undefined, selectProject: async () => undefined });
    actions.addSource("R/Project.md");
    const capture = getLastOpenedModal() as SourceCaptureModal;
    const pick = [...capture.contentEl.querySelectorAll("button")].find((el) => el.textContent === "Choose a vault note…")!;
    pick.dispatchEvent({ type: "click" } as never);
    getLastOpenedModal()!.close();
    await settle();
    expect(importSource).not.toHaveBeenCalled();
    expect(capture.contentEl.querySelector(".cc-source-capture-status")?.textContent).toBe("");
    pick.dispatchEvent({ type: "click" } as never);
    expect(getLastOpenedModal()).toBeInstanceOf(NotePickModal);
    expect(getLastOpenedModal()!.closed).toBe(false);
  });
});

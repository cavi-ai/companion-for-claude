import { App, getLastOpenedModal, type FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ChoiceModal } from "../../src/view/ChoiceModal";
import { offerIndexRebuild } from "../../src/view/rebuildOffer";

const button = (label: string) =>
  (getLastOpenedModal()?.contentEl as unknown as FakeElement).querySelectorAll("button").find(({ textContent }) => textContent === label);

describe("offerIndexRebuild", () => {
  it("opens the rebuild choice naming the new embedding source", () => {
    offerIndexRebuild(new App(), "the built-in model", async () => undefined);
    const modal = getLastOpenedModal();
    expect(modal).toBeInstanceOf(ChoiceModal);
    expect(modal?.titleEl.textContent).toBe("Rebuild the semantic index?");
    expect((modal?.contentEl as unknown as FakeElement).querySelectorAll("p")[0]?.textContent).toContain("the built-in model");
  });

  it("runs the rebuild once when Rebuild now is chosen", () => {
    const rebuild = vi.fn(async () => undefined);
    offerIndexRebuild(new App(), "ollama", rebuild);
    button("Rebuild now")?.dispatchEvent({ type: "click" });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild on Later or when the modal is dismissed", () => {
    const rebuild = vi.fn(async () => undefined);
    offerIndexRebuild(new App(), "ollama", rebuild);
    button("Later")?.dispatchEvent({ type: "click" });
    offerIndexRebuild(new App(), "ollama", rebuild);
    getLastOpenedModal()?.close();
    expect(rebuild).not.toHaveBeenCalled();
  });
});

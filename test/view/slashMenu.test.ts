import { FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SlashMenu } from "../../src/view/SlashMenu";

describe("SlashMenu", () => {
  it("selects on click without running and requires the separate Run action", () => {
    const onChoose = vi.fn();
    const parent = new FakeElement() as unknown as HTMLElement;
    const menu = new SlashMenu(parent, [{ name: "research", description: "Open Research Desk" }], onChoose);

    menu.show("research");
    (parent as unknown as FakeElement).querySelector(".cc-slash-item")!.dispatchEvent({ type: "click" });

    expect(onChoose).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
    (parent as unknown as FakeElement).querySelector(".cc-slash-run")!.dispatchEvent({ type: "click" });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ name: "research", description: "Open Research Desk" });
  });

  it("waits for a completed tap instead of selecting on finger down", () => {
    const onChoose = vi.fn();
    const parent = new FakeElement() as unknown as HTMLElement;
    const menu = new SlashMenu(parent, [{ name: "research", description: "Open Research Desk" }], onChoose);

    menu.show("research");
    const option = (parent as unknown as FakeElement).querySelector(".cc-slash-item")!;
    const preventDefault = vi.fn();
    option.dispatchEvent({ type: "pointerdown", pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10, preventDefault });
    expect(onChoose).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    option.dispatchEvent({ type: "pointerup", pointerId: 1 });
    option.dispatchEvent({ type: "mousedown", preventDefault });
    expect(onChoose).not.toHaveBeenCalled();
    option.dispatchEvent({ type: "click", preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
    (parent as unknown as FakeElement).querySelector(".cc-slash-run")!.dispatchEvent({ type: "click" });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ name: "research", description: "Open Research Desk" });
  });

  it.each(["pointermove", "pointercancel"])("keeps the menu open after %s cancels a tap", (type) => {
    const onChoose = vi.fn();
    const parent = new FakeElement();
    const menu = new SlashMenu(parent as unknown as HTMLElement, [{ name: "research", description: "Open Research Desk" }], onChoose);
    menu.show("research");
    const option = parent.querySelector(".cc-slash-item")!;
    option.dispatchEvent({ type: "pointerdown", pointerType: "touch", pointerId: 1, clientX: 10, clientY: 80, preventDefault: vi.fn() });
    option.dispatchEvent({ type, pointerId: 1, clientX: 10, clientY: 20, preventDefault: vi.fn() });
    option.dispatchEvent({ type: "pointerup", pointerId: 1 });
    option.dispatchEvent({ type: "click" });
    expect(menu.isOpen()).toBe(true);
    expect(onChoose).not.toHaveBeenCalled();
    option.dispatchEvent({ type: "pointerdown", pointerType: "touch", pointerId: 2, clientX: 10, clientY: 20, preventDefault: vi.fn() });
    option.dispatchEvent({ type: "pointerup", pointerId: 2 });
    option.dispatchEvent({ type: "click" });
    expect(onChoose).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
    parent.querySelector(".cc-slash-run")!.dispatchEvent({ type: "click" });
    expect(onChoose).toHaveBeenCalledOnce();
  });

  it("runs the last selected command rather than the first row", () => {
    const onChoose = vi.fn();
    const parent = new FakeElement();
    const menu = new SlashMenu(parent as unknown as HTMLElement, [
      { name: "research", description: "Open Research Desk" },
      { name: "rewrite", description: "Rewrite text" },
    ], onChoose);
    menu.show("re");
    const rows = parent.querySelectorAll(".cc-slash-item");
    const rewrite = rows.find((row) => row.querySelector(".cc-slash-name")?.textContent === "/rewrite")!;
    const research = rows.find((row) => row.querySelector(".cc-slash-name")?.textContent === "/research")!;
    rewrite.dispatchEvent({ type: "click" });
    research.dispatchEvent({ type: "mouseenter" });
    expect(onChoose).not.toHaveBeenCalled();
    expect(parent.querySelector(".cc-slash-selected")!.textContent).toContain("/rewrite");
    parent.querySelector(".cc-slash-run")!.dispatchEvent({ type: "click" });
    expect(onChoose).toHaveBeenCalledWith({ name: "rewrite", description: "Rewrite text" });
  });

  it("preserves rows while hovering so scrolling does not reset the list", () => {
    const parent = new FakeElement();
    const menu = new SlashMenu(parent as unknown as HTMLElement, [{ name: "research", description: "Open Research Desk" }], vi.fn());
    menu.show("research");
    const option = parent.querySelector(".cc-slash-item")!;
    option.dispatchEvent({ type: "mouseenter" });
    expect(parent.querySelector(".cc-slash-item")).toBe(option);
  });

  it("stays open after a blur when focus is back in the composer input, and hides when it went elsewhere", () => {
    const parent = new FakeElement();
    const input = new FakeElement();
    const menu = new SlashMenu(parent as unknown as HTMLElement, [{ name: "brainstorm", description: "Brainstorm ideas" }], vi.fn());
    const menuEl = parent.querySelector(".cc-slash-menu")! as unknown as { ownerDocument: { activeElement: unknown } };
    menuEl.ownerDocument = { activeElement: input };
    menu.show("brainstorm");

    menu.hideUnlessFocused(input as unknown as Element);
    expect(menu.isOpen()).toBe(true);

    menuEl.ownerDocument = { activeElement: new FakeElement() };
    menu.hideUnlessFocused(input as unknown as Element);
    expect(menu.isOpen()).toBe(false);
  });
});

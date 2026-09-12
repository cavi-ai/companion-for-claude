import { FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SlashMenu } from "../../src/view/SlashMenu";

describe("SlashMenu", () => {
  it("chooses a command when activated by click only", () => {
    const onChoose = vi.fn();
    const parent = new FakeElement() as unknown as HTMLElement;
    const menu = new SlashMenu(parent, [{ name: "research", description: "Open Research Desk" }], onChoose);

    menu.show("research");
    (parent as unknown as FakeElement).querySelector(".cc-slash-item")!.dispatchEvent({ type: "click" });

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ name: "research", description: "Open Research Desk" });
  });

  it("chooses a touch-selected command exactly once before a trailing mouse event", () => {
    const onChoose = vi.fn();
    const parent = new FakeElement() as unknown as HTMLElement;
    const menu = new SlashMenu(parent, [{ name: "research", description: "Open Research Desk" }], onChoose);

    menu.show("research");
    const option = (parent as unknown as FakeElement).querySelector(".cc-slash-item")!;
    const preventDefault = vi.fn();
    option.dispatchEvent({ type: "pointerdown", preventDefault });
    expect(onChoose).toHaveBeenCalledTimes(1);
    option.dispatchEvent({ type: "mousedown", preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ name: "research", description: "Open Research Desk" });
  });
});

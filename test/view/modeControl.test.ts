import { describe, it, expect, vi } from "vitest";
import { FakeElement } from "obsidian";
import { ModeControl } from "../../src/view/ModeControl";

const host = () => new FakeElement() as unknown as HTMLElement;
// The shared FakeElement has no click()/KeyboardEvent global (vitest runs in
// the `node` environment) — dispatch plain event-shaped objects instead.
const click = () => ({ type: "click" });
const keydown = (key: string) => ({ type: "keydown", key, preventDefault: () => {} });

describe("ModeControl", () => {
  it("renders three radios with the initial state checked", () => {
    const c = new ModeControl(host(), { initial: "act", onChange: () => {} });
    const radios = (c.el as unknown as FakeElement).querySelectorAll("button");
    expect(radios.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(c.el.getAttribute("role")).toBe("radiogroup");
  });
  it("fires onChange with the clicked mode and updates aria-checked", () => {
    const onChange = vi.fn();
    const c = new ModeControl(host(), { initial: "ask", onChange });
    const radios = (c.el as unknown as FakeElement).querySelectorAll("button");
    radios[1]!.dispatchEvent(click());
    expect(onChange).toHaveBeenCalledWith("plan");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
  });
  it("set() changes the state without firing onChange", () => {
    const onChange = vi.fn();
    const c = new ModeControl(host(), { initial: "ask", onChange });
    c.set("act");
    expect(onChange).not.toHaveBeenCalled();
    const radios = (c.el as unknown as FakeElement).querySelectorAll("button");
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
  });
  it("arrow keys move the selection", () => {
    const onChange = vi.fn();
    const c = new ModeControl(host(), { initial: "ask", onChange });
    (c.el as unknown as FakeElement).dispatchEvent(keydown("ArrowRight"));
    expect(onChange).toHaveBeenCalledWith("plan");
  });
  it("arrow keys move focus to the newly selected segment", () => {
    const c = new ModeControl(host(), { initial: "ask", onChange: () => {} });
    (c.el as unknown as FakeElement).dispatchEvent(keydown("ArrowRight"));
    const radios = (c.el as unknown as FakeElement).querySelectorAll("button");
    expect(radios[1]!.getAttribute("data-focused")).toBe("true");
  });
});

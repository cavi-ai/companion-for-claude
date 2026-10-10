import { describe, it, expect, vi } from "vitest";
import { FakeElement } from "obsidian";
import { ModeControl } from "../../src/view/ModeControl";
import { ChatModeState } from "../../src/view/chat/chatMode";

const host = () => new FakeElement() as unknown as HTMLElement;
// The shared FakeElement has no click()/KeyboardEvent global (vitest runs in
// the `node` environment) — dispatch plain event-shaped objects instead.
const click = () => ({ type: "click" });
const keydown = (key: string) => ({ type: "keydown", key, preventDefault: () => {} });

function chatMode(writes = false): ChatModeState {
  const setting = { writes };
  return new ChatModeState({ writes: () => setting.writes, setWrites: (on) => { setting.writes = on; }, save: async () => undefined, notify: () => {} });
}
const radiosOf = (c: ModeControl) => (c.el as unknown as FakeElement).querySelectorAll("button");
const checked = (c: ModeControl) => radiosOf(c).map((b) => b.getAttribute("aria-checked"));

describe("ModeControl", () => {
  it("renders three radios with the chat's mode checked", () => {
    const c = new ModeControl(host(), chatMode(true));
    expect(checked(c)).toEqual(["false", "false", "true"]);
    expect(c.el.getAttribute("role")).toBe("radiogroup");
  });

  it("changes the chat's mode on click", () => {
    const mode = chatMode();
    const c = new ModeControl(host(), mode);
    radiosOf(c)[1]!.dispatchEvent(click());
    expect(mode.mode).toBe("plan");
    expect(checked(c)).toEqual(["false", "true", "false"]);
  });

  it("follows a mode change made elsewhere, and stops after dispose", async () => {
    const mode = chatMode();
    const c = new ModeControl(host(), mode);
    await mode.change("act");
    expect(checked(c)).toEqual(["false", "false", "true"]);
    c.dispose();
    await mode.change("plan");
    expect(checked(c)).toEqual(["false", "false", "true"]);
  });

  it("hides while the backend can't run tools", () => {
    const mode = chatMode();
    const c = new ModeControl(host(), mode);
    expect([...(c.el as unknown as FakeElement).classList]).toContain("is-hidden");
    mode.setCapable(true);
    expect([...(c.el as unknown as FakeElement).classList]).not.toContain("is-hidden");
  });

  it("arrow keys move the selection and focus", () => {
    const mode = chatMode();
    const change = vi.spyOn(mode, "change");
    const c = new ModeControl(host(), mode);
    (c.el as unknown as FakeElement).dispatchEvent(keydown("ArrowRight"));
    expect(change).toHaveBeenCalledWith("plan");
    expect(radiosOf(c)[1]!.getAttribute("data-focused")).toBe("true");
  });
});

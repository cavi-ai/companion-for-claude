import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeElement } from "obsidian";
import { panePopoverBounds, PanePopover } from "../../src/view/panePopover";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const mounted: PanePopover[] = [];
afterEach(() => { mounted.splice(0).forEach((popover) => popover.dispose()); vi.unstubAllGlobals(); });

function setup() {
  const doc = Object.assign(new FakeElement("document"), { body: new FakeElement("body"), activeElement: null as unknown });
  const pane = doc.body.createDiv({ cls: "cc-chat-root" });
  pane.rect = rect(700, 30, 1020, 760);
  const header = pane.createDiv({ cls: "cc-header" }); header.rect = rect(700, 30, 1020, 120);
  const feedback = pane.createDiv({ cls: "cc-feedback-host" }); feedback.rect = rect(700, 120, 1020, 170);
  const composer = pane.createDiv({ cls: "cc-composer" }); composer.rect = rect(700, 600, 1020, 760);
  const anchor = header.createEl("button"); anchor.rect = rect(950, 38, 1010, 80); anchor.ownerDocument = doc;
  const panel = pane.createDiv();
  vi.stubGlobal("activeDocument", doc);
  vi.stubGlobal("activeWindow", { innerWidth: 1280, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const onDismiss = vi.fn();
  const popover = new PanePopover({ anchor: anchor as never, panel: panel as never, onDismiss }); mounted.push(popover);
  return { doc, pane, anchor, panel, onDismiss, popover, header, composer, feedback };
}

describe("pane-owned popovers", () => {
  it("clamps to the pane below all header feedback and above the composer", () => {
    expect(panePopoverBounds({ pane: rect(700, 30, 1020, 760), anchor: rect(950, 38, 1010, 80), headerBottom: 120, feedbackBottom: 170, composerTop: 600, viewportWidth: 1280, viewportHeight: 800 }))
      .toEqual({ left: 708, top: 174, width: 304, maxHeight: 418 });
  });

  it("repositions when pane/header/feedback/composer resize and releases observers", () => {
    const observe = vi.fn(); const disconnect = vi.fn(); let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe = observe; disconnect = disconnect; });
    const { panel, feedback, popover } = setup();
    expect(panel.style.top).toBe("144px"); expect(panel.style["max-height"]).toBe("418px");
    feedback.rect.bottom = 210; resize();
    expect(panel.style.top).toBe("184px"); expect(observe).toHaveBeenCalledTimes(5);
    popover.dispose(); popover.dispose(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it("dismisses outside without moving focus and restores the trigger on Escape", () => {
    const { doc, panel, anchor, onDismiss, popover } = setup();
    doc.dispatchEvent({ type: "mousedown", target: panel }); expect(onDismiss).not.toHaveBeenCalled();
    doc.dispatchEvent({ type: "mousedown", target: new FakeElement("button") });
    expect(onDismiss).toHaveBeenLastCalledWith("outside"); expect(anchor.getAttribute("data-focused")).toBeNull();
    popover.dispose();
    doc.dispatchEvent({ type: "keydown", key: "Escape", preventDefault: vi.fn() });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("replaces only another surface in its own pane", () => {
    const { pane, anchor, onDismiss } = setup();
    const second = new PanePopover({ anchor: anchor as never, panel: pane.createDiv() as never, onDismiss: vi.fn() }); mounted.push(second);
    expect(onDismiss).toHaveBeenCalledWith("replace");
    const other = setup(); expect(other.onDismiss).not.toHaveBeenCalled();
  });
  it("Escape affects only the pane that owns the keyboard target", () => {
    const { doc, onDismiss } = setup();
    const otherPane = doc.body.createDiv({ cls: "cc-chat-root" });
    otherPane.rect = rect(10, 30, 330, 760);
    const otherAnchor = otherPane.createEl("button"); otherAnchor.ownerDocument = doc;
    const otherPanel = otherPane.createDiv(); const dismissOther = vi.fn();
    mounted.push(new PanePopover({ anchor: otherAnchor as never, panel: otherPanel as never, onDismiss: dismissOther }));
    doc.dispatchEvent({ type: "keydown", key: "Escape", target: otherPanel, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onDismiss).not.toHaveBeenCalled(); expect(dismissOther).toHaveBeenCalledWith("escape");
  });

});

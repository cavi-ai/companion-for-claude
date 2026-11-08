import { afterEach, describe, expect, it } from "vitest";
import { FakeElement, Notice, clearNotices, getNotices, fakeDocument } from "obsidian";
import { CompanionNotice, mountFeedbackHost, quickNotice, QUICK_NOTICE_MS } from "../src/notice";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); clearNotices(); });

function pane() {
  const root = new FakeElement(); root.addClass("cc-chat-root");
  const header = root.createDiv({ cls: "cc-header" });
  const transcript = root.createDiv({ cls: "cc-messages" });
  cleanups.push(mountFeedbackHost(root as never));
  return { root, header, transcript, host: root.querySelector(".cc-feedback-host")! };
}

describe("Companion feedback", () => {
  it("keeps the native Notice instance and duration in a host after the complete header", () => {
    const { root, header, transcript, host } = pane();
    const notice = quickNotice("Copied");
    expect(notice).toBeInstanceOf(Notice); expect(getNotices()[0]).toBe(notice);
    expect(notice.timeout).toBe(QUICK_NOTICE_MS);
    expect(host.contains(notice.containerEl)).toBe(true);
    expect(host.getAttribute("role")).toBe("status"); expect(host.getAttribute("aria-live")).toBe("polite");
    expect(root.children).toEqual([header, host, transcript]);
    notice.hide(); expect(host.contains(notice.containerEl)).toBe(false);
  });

  it("preserves long and persistent native lifetimes", () => {
    pane();
    expect(new CompanionNotice("Details", 9000).timeout).toBe(9000);
    expect(new CompanionNotice("Working", 0).timeout).toBe(0);
    expect(new CompanionNotice("Default").timeout).toBeUndefined();
  });

  it("moves a live notice out of an unmounted pane without hiding it", () => {
    const { host } = pane(); const notice = new CompanionNotice("Working", 0);
    expect(host.contains(notice.containerEl)).toBe(true);
    cleanups.pop()!();
    expect(notice.hidden).toBe(false); expect(host.contains(notice.containerEl)).toBe(false);
    expect(notice.containerEl.parent?.classList.has("cc-feedback-fallback")).toBe(true);
    notice.hide();
  });
  it("offers native keyboard dismissal and retains it after updating the message", () => {
    const { host } = pane(); const notice = new CompanionNotice("Working", 0);
    const dismiss = host.querySelector(".cc-feedback-dismiss")!;
    expect(dismiss.tagName).toBe("BUTTON"); expect(dismiss.getAttribute("aria-label")).toBe("Dismiss feedback");
    expect(notice.setMessage("Finished")).toBe(notice);
    expect(host.querySelectorAll(".cc-feedback-dismiss")).toHaveLength(1);
    dismiss.dispatchEvent({ type: "click", stopPropagation: () => undefined });
    expect(notice.hidden).toBe(true); expect(host.contains(notice.containerEl)).toBe(false);
  });

  it("returns focus to the creation control for both dismissal and native hide", () => {
    const { root, host } = pane();
    const input = root.createEl("textarea", { cls: "cc-input" });
    input.focus();
    const manual = new CompanionNotice("Saved", 0);
    const dismiss = host.querySelector(".cc-feedback-dismiss")!; dismiss.focus();
    dismiss.dispatchEvent({ type: "click", stopPropagation: () => undefined });
    expect(fakeDocument.activeElement).toBe(input); expect(manual.hidden).toBe(true);
    const timed = new CompanionNotice("Copied", 1800);
    host.querySelector(".cc-feedback-dismiss")!.focus(); timed.hide();
    expect(fakeDocument.activeElement).toBe(input); expect(timed.timeout).toBe(1800);
  });

  it("does not restore notice focus when the user has moved to another control", () => {
    const { root } = pane();
    const original = root.createEl("textarea", { cls: "cc-input" }); const other = root.createEl("button");
    original.focus(); const notice = new CompanionNotice("Copied", 0);
    other.focus(); notice.hide(); expect(fakeDocument.activeElement).toBe(other);
  });

  it("uses the visible pane composer when the original control disappeared or became hidden", () => {
    const { root, host } = pane();
    const composer = root.createEl("textarea", { cls: "cc-input" }); const original = root.createEl("button");
    original.focus(); const notice = new CompanionNotice("Saved", 0);
    Object.assign(original, { isConnected: false }); original.remove();
    host.querySelector(".cc-feedback-dismiss")!.focus(); notice.hide();
    expect(fakeDocument.activeElement).toBe(composer);
    const hidden = root.createEl("button"); hidden.focus(); const second = new CompanionNotice("Updated", 0);
    Object.assign(hidden, { checkVisibility: () => false });
    host.querySelector(".cc-feedback-dismiss")!.focus(); second.hide();
    expect(fakeDocument.activeElement).toBe(composer);
  });

  it("uses the visible model control when the composer is unavailable", () => {
    const { root, host } = pane(); const model = root.createEl("button", { cls: "cc-model" });
    const original = root.createEl("button"); original.focus(); const notice = new CompanionNotice("Saved", 0);
    Object.assign(original, { isConnected: false }); original.remove();
    const composer = root.createEl("textarea", { cls: "cc-input" }); Object.assign(composer, { disabled: true });
    host.querySelector(".cc-feedback-dismiss")!.focus(); notice.hide();
    expect(fakeDocument.activeElement).toBe(model);
  });

});

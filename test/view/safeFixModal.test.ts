import { App, FakeElement, clearNotices, getNoticeMessages } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { SafeFix } from "../../src/health/controller";
import { SafeFixModal } from "../../src/view/SafeFixModal";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const fixes: SafeFix[] = [
  { path: "a.md", changes: [{ key: "aliases", from: "solo", to: ["solo"] }], fixed: { type: "tagged", aliases: ["solo"], title: "A" } },
  { path: "b.md", changes: [{ key: "aliases", from: "x", to: ["x"] }], fixed: { type: "tagged", aliases: ["x"], title: "B" } },
];

const button = (root: FakeElement, text: string): FakeElement =>
  root.querySelectorAll("button").find((b) => b.textContent === text)!;

describe("SafeFixModal", () => {
  it("labels each choice with the note and proposed property changes", () => {
    const modal = new SafeFixModal(new App(), fixes, async () => undefined, () => {});
    modal.onOpen();
    const labels = (modal.contentEl as unknown as FakeElement).querySelectorAll("label");
    expect(labels).toHaveLength(2);
    labels.forEach((label, i) => {
      expect(label.querySelector("input")).not.toBeNull();
      expect(label.querySelector(".cc-safe-fix-path")?.textContent).toBe(fixes[i]!.path);
      expect(label.querySelector(".cc-safe-fix-change")?.textContent).toContain("aliases:");
    });
  });

  it("reports a failed note, continues other selected notes and prevents duplicate apply", async () => {
    clearNotices();
    const write = vi.fn(async (fix: SafeFix) => { if (fix.path === "a.md") throw new Error("This note changed since review."); });
    const onDone = vi.fn();
    const modal = new SafeFixModal(new App(), fixes, write, onDone);
    modal.onOpen();
    const apply = button(modal.contentEl as unknown as FakeElement, "Apply selected");
    apply.dispatchEvent({ type: "click" });
    apply.dispatchEvent({ type: "click" });
    await settle();
    expect(write.mock.calls.map(([fix]) => fix.path)).toEqual(["a.md", "b.md"]);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(1);
    expect(getNoticeMessages().join("\n")).toContain("a.md: This note changed since review.");
    expect(getNoticeMessages().join("\n")).toContain("Applied 1 of 2 selected fixes");
  });

  it("writes only checked notes and assigns only changed keys", async () => {
    const write = vi.fn(async () => undefined);
    const onDone = vi.fn();
    const modal = new SafeFixModal(new App(), fixes, write, onDone);
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const checks = root.querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
    expect(checks.map((c) => c.checked)).toEqual([true, true]);
    checks[1]!.checked = false;
    button(root, "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(fixes[0]);
    expect(onDone).toHaveBeenCalledWith(1);
  });

  it("cancel writes nothing", async () => {
    const write = vi.fn(async () => undefined);
    const onDone = vi.fn();
    const modal = new SafeFixModal(new App(), fixes, write, onDone);
    modal.onOpen();
    button(modal.contentEl as unknown as FakeElement, "Cancel").dispatchEvent({ type: "click" });
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(0);
  });
});

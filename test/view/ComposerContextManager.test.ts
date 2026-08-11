import { FakeElement } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerContextManager, type ComposerContextManagerCallbacks } from "../../src/view/ComposerContextManager";
import type { ContextManagerModel } from "../../src/view/contextManagerModel";

function modelWithAllKinds(): ContextManagerModel {
  const visible = {
    activeCount: 4,
    summary: "Context · This note + 3",
    automatic: [
      { key: "activeNote" as const, label: "This note", enabled: true, detail: "Notes/Alpha.md" },
      { key: "selection" as const, label: "Selection", enabled: false },
      { key: "linkedNotes" as const, label: "Linked notes", enabled: false },
      { key: "searchVault" as const, label: "Entire vault", enabled: false },
    ],
    sources: [
      { id: "media:pdf:Files/Study.pdf", kind: "pdf" as const, label: "Study.pdf", detail: "Files/Study.pdf", status: "ready" as const },
      { id: "page:https://pending.test/article", kind: "webpage" as const, label: "Pending article", detail: "pending.test/article", status: "pending" as const },
      { id: "page:https://failed.test/article", kind: "webpage" as const, label: "Failed article", detail: "failed.test/article", status: "error" as const, error: "Capture timed out" },
    ],
  };
  return { ...visible, signature: JSON.stringify(visible) };
}

function allText(element: FakeElement): string {
  return [element.textContent, ...element.children.map(allText)].join(" ");
}

function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function byAria(host: FakeElement, label: string): FakeElement {
  const match = descendants(host).find((element) => element.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Missing control: ${label}`);
  return match;
}

function byRole(host: FakeElement, role: string): FakeElement {
  const match = descendants(host).find((element) => element.getAttribute("role") === role);
  if (!match) throw new Error(`Missing role: ${role}`);
  return match;
}

describe("ComposerContextManager", () => {
  let host: FakeElement;
  let callbacks: {
    toggleAutomatic: ReturnType<typeof vi.fn>;
    removeSource: ReturnType<typeof vi.fn>;
    retrySource: ReturnType<typeof vi.fn>;
    addContext: ReturnType<typeof vi.fn>;
  };
  let manager: ComposerContextManager;

  beforeEach(() => {
    host = new FakeElement();
    callbacks = { toggleAutomatic: vi.fn(), removeSource: vi.fn(), retrySource: vi.fn(), addContext: vi.fn() };
    manager = new ComposerContextManager(host as unknown as HTMLElement, callbacks as ComposerContextManagerCallbacks);
  });

  it("renders one compact trigger and a named surface with explicit status semantics", () => {
    manager.render(modelWithAllKinds());

    expect(host.querySelectorAll(".cc-context-trigger")).toHaveLength(1);
    expect(host.querySelectorAll(".cc-attach-pill")).toHaveLength(0);
    expect(byAria(host, "Manage context, 4 items active").getAttribute("aria-expanded")).toBe("false");

    byAria(host, "Manage context, 4 items active").dispatchEvent({ type: "click" });
    const dialog = byRole(host, "dialog");
    expect(dialog.getAttribute("aria-labelledby")).not.toBeNull();
    expect(host.querySelectorAll("input")).toHaveLength(4);
    expect(allText(byRole(host, "status"))).toContain("Pending");
    expect(allText(byRole(host, "alert"))).toContain("Capture timed out");
    expect(byAria(host, "Remove Failed article")).toBeDefined();
    expect(byAria(host, "Retry Failed article")).toBeDefined();
  });

  it("dispatches toggle, remove, retry, and add actions without closing", () => {
    manager.render(modelWithAllKinds());
    manager.open();

    byAria(host, "Entire vault").dispatchEvent({ type: "change", target: { checked: true } });
    byAria(host, "Remove Study.pdf").dispatchEvent({ type: "click" });
    byAria(host, "Retry Failed article").dispatchEvent({ type: "click" });
    byAria(host, "Add context").dispatchEvent({ type: "click" });

    expect(callbacks.toggleAutomatic).toHaveBeenCalledWith("searchVault", true);
    expect(callbacks.removeSource).toHaveBeenCalledWith("media:pdf:Files/Study.pdf");
    expect(callbacks.retrySource).toHaveBeenCalledWith("page:https://failed.test/article");
    expect(callbacks.addContext).toHaveBeenCalledOnce();
    expect(manager.isOpen()).toBe(true);
  });

  it("restores trigger focus on Escape and removes owned DOM on destroy", () => {
    manager.render(modelWithAllKinds());
    manager.open();

    byRole(host, "dialog").dispatchEvent({ type: "keydown", key: "Escape", preventDefault: vi.fn() });

    expect(manager.isOpen()).toBe(false);
    expect(byAria(host, "Manage context, 4 items active").getAttribute("data-focused")).toBe("true");
    manager.destroy();
    expect(host.children).toHaveLength(0);
  });

  it("preserves open state and focused source control across a render refresh", () => {
    manager.render(modelWithAllKinds());
    manager.open();
    const remove = byAria(host, "Remove Study.pdf");
    remove.dispatchEvent({ type: "focus" });
    remove.focus();

    const next = modelWithAllKinds();
    next.activeCount = 5;
    next.summary = "Context · This note + 4";
    next.signature = "refreshed";
    manager.render(next);

    expect(manager.isOpen()).toBe(true);
    expect(byAria(host, "Remove Study.pdf").getAttribute("data-focused")).toBe("true");
  });
});

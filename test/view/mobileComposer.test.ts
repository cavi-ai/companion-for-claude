import { App, FakeElement, Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerDeps } from "../../src/view/chat/Composer";
import { DEFAULT_SETTINGS } from "../../src/types";
import { defaultChatControls } from "../../src/claude/chatControls";
import type ClaudeCompanionPlugin from "../../src/main";

function mountComposer(): { root: FakeElement; composer: Composer; deps: ComposerDeps } {
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    router: () => ({
      ollama: { listModels: async () => [] },
      openaiCompat: { listModels: async () => [] },
      chatCapabilities: () => ({ agentActions: true, claudeControls: false, metered: false, local: false, cli: false }),
    }),
  } as unknown as ClaudeCompanionPlugin;
  const deps = {
    applyMode: vi.fn(async () => undefined),
    currentMode: () => "ask",
    updateModeControl: vi.fn(),
    refreshCapabilityIndicators: vi.fn(),
    registerDomEvent: vi.fn(),
    mountUsage: (parent: HTMLElement) => { parent.createDiv({ cls: "cc-usage" }); },
    controls: () => defaultChatControls(DEFAULT_SETTINGS.model),
    onSend: vi.fn(),
  } as unknown as ComposerDeps;
  const composer = new Composer(new App() as never, plugin, deps);
  const root = new FakeElement();
  composer.mount(root as unknown as HTMLElement, []);
  return { root, composer, deps };
}

function classesOf(children: FakeElement[]): string[] {
  return children.map((child) => [...child.classList][0] ?? child.tagName);
}

describe("Composer layout", () => {
  afterEach(() => {
    Platform.isMobile = false;
  });

  it("keeps the mobile input and Send in one input row, with context and Ask / Plan / Act in a toolbar under it", () => {
    Platform.isMobile = true;
    const { root, composer, deps } = mountComposer();

    const composerEl = root.querySelector(".cc-composer")!;
    const order = classesOf(composerEl.children);
    expect(order.indexOf("cc-composer-input-row")).toBe(order.indexOf("cc-composer-toolbar") - 1);
    const row = composerEl.querySelector(".cc-composer-input-row")!;
    expect(row.children).toEqual([composer.inputEl, composer.sendBtn]);
    expect([...composer.sendBtn.classList]).toContain("cc-send-icon");
    const toolbar = composerEl.querySelector(".cc-composer-toolbar")!;
    expect(classesOf(toolbar.children)).toEqual(["cc-context-manager", "cc-mode-control"]);
    expect(composer.modeControl?.el).toBe(toolbar.querySelector(".cc-mode-control") as unknown as HTMLElement);
    expect(root.querySelectorAll(".cc-mode-control")).toHaveLength(1);
    expect(root.querySelectorAll(".cc-context-manager")).toHaveLength(1);
    expect(root.querySelector(".cc-composer-card")).toBeNull();
    expect(deps.updateModeControl).toHaveBeenCalledOnce();
  });

  it("keeps the desktop layout: context manager first, mode switch in the controls bar", () => {
    const { root, composer } = mountComposer();

    const composerEl = root.querySelector(".cc-composer")!;
    expect(classesOf(composerEl.children)[0]).toBe("cc-context-manager");
    expect(root.querySelector(".cc-composer-input-row")).toBeNull();
    expect(root.querySelector(".cc-composer-toolbar")).toBeNull();
    expect(root.querySelector(".cc-controls")!.querySelector(".cc-mode-control")).toBe(composer.modeControl?.el as unknown as FakeElement);
    expect(root.querySelector(".cc-send-group")!.querySelector(".cc-send")).toBe(composer.sendBtn as unknown as FakeElement);
  });
});

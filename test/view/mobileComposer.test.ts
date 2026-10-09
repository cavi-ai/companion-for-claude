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

  it("puts the context chip, the mode switch, and Send in one toolbar under the input on mobile", () => {
    Platform.isMobile = true;
    const { root, composer, deps } = mountComposer();

    const card = root.querySelector(".cc-composer-card")!;
    expect(classesOf(card.children)).toEqual(["cc-input", "cc-composer-toolbar", "cc-composer-bar"]);
    const toolbar = card.querySelector(".cc-composer-toolbar")!;
    expect(classesOf(toolbar.children)).toEqual(["cc-context-manager", "cc-mode-control", "cc-send"]);
    expect(toolbar.querySelector(".cc-send")).toBe(composer.sendBtn as unknown as FakeElement);
    expect(composer.modeControl?.el).toBe(toolbar.querySelector(".cc-mode-control") as unknown as HTMLElement);
    expect(root.querySelectorAll(".cc-mode-control")).toHaveLength(1);
    expect(root.querySelector(".cc-controls")!.querySelector(".cc-mode-control")).toBeNull();
    expect(root.querySelectorAll(".cc-context-manager")).toHaveLength(1);
    expect(deps.updateModeControl).toHaveBeenCalledOnce();
  });

  it("keeps the desktop layout: context manager first, mode switch in the controls bar", () => {
    const { root, composer } = mountComposer();

    const composerEl = root.querySelector(".cc-composer")!;
    expect(classesOf(composerEl.children)[0]).toBe("cc-context-manager");
    expect(root.querySelector(".cc-composer-card")).toBeNull();
    expect(root.querySelector(".cc-composer-toolbar")).toBeNull();
    expect(root.querySelector(".cc-controls")!.querySelector(".cc-mode-control")).toBe(composer.modeControl?.el as unknown as FakeElement);
    expect(root.querySelector(".cc-send-group")!.querySelector(".cc-send")).toBe(composer.sendBtn as unknown as FakeElement);
  });
});

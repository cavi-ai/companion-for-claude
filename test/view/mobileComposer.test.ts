import { App, FakeElement, Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerDeps } from "../../src/view/chat/Composer";
import { ChatSession } from "../../src/view/chat/chatSession";
import { DEFAULT_SETTINGS } from "../../src/types";
import { defaultChatControls } from "../../src/claude/chatControls";
import type { ComposerHost } from "../../src/view/chat/hosts";

function mountComposer(): { root: FakeElement; composer: Composer; chat: ChatSession } {
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    router: () => ({
      ollama: { listModels: async () => [] },
      openaiCompat: { listModels: async () => [] },
      chatCapabilities: () => ({ agentActions: true, claudeControls: false, metered: false, local: false, cli: false }),
    }),
    saveSettings: vi.fn(async () => undefined),
    captureWebPage: () => false,
  } as unknown as ComposerHost;
  const deps = {
    refreshCapabilityIndicators: vi.fn(),
    registerDomEvent: vi.fn(),
    mountUsage: (parent: HTMLElement) => { parent.createDiv({ cls: "cc-usage" }); },
    onSend: vi.fn(),
  } as unknown as ComposerDeps;
  const chat = new ChatSession({ writes: () => false, setWrites: vi.fn(), save: vi.fn(async () => undefined), notify: vi.fn() });
  chat.controls = defaultChatControls(DEFAULT_SETTINGS.model);
  const composer = new Composer(new App() as never, plugin, chat, deps);
  const root = new FakeElement();
  composer.mount(root as unknown as HTMLElement, []);
  return { root, composer, chat };
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
    const { root, composer, chat } = mountComposer();

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
    chat.mode.setCapable(true);
    expect([...composer.modeControl!.el.classList]).not.toContain("is-hidden");
  });

  it("stops following the chat's mode once destroyed", async () => {
    const { composer, chat } = mountComposer();
    const control = composer.modeControl!;
    const checkedLabel = () => (control.el as unknown as FakeElement).querySelectorAll("button").find((b) => b.getAttribute("aria-checked") === "true")?.getAttribute("aria-label");
    composer.destroy();
    await chat.mode.change("plan");
    expect(checkedLabel()).toMatch(/^Ask/);
  });

  it("replaces the draft focused and unsent, and reads it back", () => {
    const { composer } = mountComposer();
    composer.setDraft("Summarize this note");
    expect(composer.draft()).toBe("Summarize this note");
    expect(composer.inputEl.getAttribute("data-focused")).toBe("true");
  });

  it("shows whether the model reasons on the reasoning indicator", () => {
    const { root, composer } = mountComposer();
    const indicator = root.querySelector(".cc-reasoning-indicator");
    expect(indicator).not.toBeNull();
    composer.showReasoning(true, "Reasoning on");
    expect([...indicator!.classList]).toContain("is-active");
    expect(indicator!.getAttribute("aria-label")).toBe("Reasoning on");
    composer.showReasoning(false, "Reasoning off");
    expect([...indicator!.classList]).not.toContain("is-active");
    expect(indicator!.getAttribute("title")).toBe("Reasoning off");
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

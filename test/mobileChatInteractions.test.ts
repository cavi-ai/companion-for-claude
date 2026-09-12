import { describe, expect, it } from "vitest";
import { App, FakeElement, getLastOpenedModal, WorkspaceLeaf } from "./fakes/obsidian";
import { ChatView } from "../src/view/ChatView";
import { DEFAULT_SETTINGS } from "../src/types";
import type ClaudeCompanionPlugin from "../src/main";

function pluginStub(): ClaudeCompanionPlugin {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    router: () => ({
      chatProvider: () => ({ provider: { id: "anthropic" }, model: DEFAULT_SETTINGS.model }),
      chatCapabilities: () => ({ agentActions: true, claudeControls: true, metered: true, local: false, cli: false }),
    }),
  } as unknown as ClaudeCompanionPlugin;
}

describe("mobile chat interactions", () => {
  it("opens overflow actions in a touch-safe modal and reaches Companion settings", () => {
    const app = new App() as App & { setting: { open(): void; openTabById(id: string): void } };
    let opened = 0;
    let tabId = "";
    app.setting = {
      open: () => { opened += 1; },
      openTabById: (id) => { tabId = id; },
    };
    const view = new ChatView(new WorkspaceLeaf(app), pluginStub());

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();

    const modal = getLastOpenedModal();
    const content = modal?.contentEl as unknown as FakeElement;
    const settings = content.querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Settings");
    expect(settings).toBeDefined();

    settings?.dispatchEvent({ type: "click" });
    expect(opened).toBe(1);
    expect(tabId).toBe("claude-companion");
  });

  it("falls back to Obsidian's settings command when the mobile settings controller is absent", () => {
    const app = new App() as App & { commands: { executeCommandById(id: string): boolean } };
    let command = "";
    app.commands = { executeCommandById: (id) => { command = id; return true; } };
    const view = new ChatView(new WorkspaceLeaf(app), pluginStub());

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();
    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    content.querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Settings")
      ?.dispatchEvent({ type: "click" });
    expect(command).toBe("app:open-settings");
  });

  it("opens the configured model choices in the same touch-safe surface", () => {
    const view = new ChatView(new WorkspaceLeaf(new App()), pluginStub());
    (view as unknown as { controls: { model: string } }).controls = { model: DEFAULT_SETTINGS.model };

    (view as unknown as { openModelMenu(): void }).openModelMenu();

    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    const choices = content.querySelectorAll("button");
    expect(choices.length).toBeGreaterThan(1);
    expect(choices.some((button) => button.getAttribute("aria-pressed") === "true")).toBe(true);
  });

  it("turning Plan mode off from the overflow menu leaves the writes setting untouched", () => {
    const plugin = pluginStub();
    plugin.settings.agentAllowWrites = true;
    let saveCalled = false;
    (plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings = async () => { saveCalled = true; };
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    (view as unknown as { planMode: boolean }).planMode = true;

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();
    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    content.querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Plan mode")
      ?.dispatchEvent({ type: "click" });

    expect(plugin.settings.agentAllowWrites).toBe(true);
    expect((view as unknown as { planMode: boolean }).planMode).toBe(false);
    expect(saveCalled).toBe(false);
  });

  it("titles a local session with the friendly model label, not the raw slug", () => {
    const plugin = pluginStub();
    plugin.router = () => ({
      chatProvider: () => ({ provider: { id: "ollama" }, model: "qwen2.5-coder:7b" }),
      chatCapabilities: () => ({ agentActions: true, claudeControls: true, metered: false, local: true, cli: false }),
    }) as unknown as ClaudeCompanionPlugin["router"];
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    (view as unknown as { modelLabelEl: FakeElement }).modelLabelEl = new FakeElement();

    view.refreshModelLabel();

    expect((view as unknown as { modelLabelEl: FakeElement }).modelLabelEl.textContent).toBe("Qwen2.5 Coder:7b · local");
  });

  it("does not repeat the Claude Code backend in the model label", () => {
    const plugin = pluginStub();
    plugin.router = () => ({
      chatProvider: () => ({ provider: { id: "claude-cli" }, model: DEFAULT_SETTINGS.model }),
      chatCapabilities: () => ({ agentActions: true, claudeControls: false, metered: false, local: false, cli: true }),
    }) as unknown as ClaudeCompanionPlugin["router"];
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    (view as unknown as { controls: { model: string }; modelLabelEl: FakeElement }).controls = { model: DEFAULT_SETTINGS.model };
    (view as unknown as { modelLabelEl: FakeElement }).modelLabelEl = new FakeElement();

    view.refreshModelLabel();

    expect((view as unknown as { modelLabelEl: FakeElement }).modelLabelEl.textContent).toBe("Claude Sonnet 5");
  });
});

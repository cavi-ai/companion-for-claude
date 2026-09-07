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
});

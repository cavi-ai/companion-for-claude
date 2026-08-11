import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { DesktopIntegrationViewState } from "../../src/integrations/desktopCoordinator";
import {
  DesktopIntegrationsModal,
  type DesktopIntegrationsController,
} from "../../src/view/DesktopIntegrationsModal";

class Controller implements DesktopIntegrationsController {
  state: DesktopIntegrationViewState;
  listener: ((state: DesktopIntegrationViewState) => void) | null = null;
  refresh = vi.fn(async () => undefined);
  setupClaudeCode = vi.fn(async (_confirm: () => Promise<boolean>) => undefined);
  connectClaudeDesktop = vi.fn(async (_confirm: () => Promise<boolean>) => undefined);
  openTerminal = vi.fn(async () => undefined);
  dispose = vi.fn();

  constructor(state: DesktopIntegrationViewState) { this.state = state; }
  snapshot(): DesktopIntegrationViewState { return this.state; }
  subscribe(listener: (state: DesktopIntegrationViewState) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  emit(state: DesktopIntegrationViewState): void {
    this.state = state;
    this.listener?.(state);
  }
}

const root = (modal: DesktopIntegrationsModal): FakeElement => modal.contentEl as unknown as FakeElement;
const visibleText = (modal: DesktopIntegrationsModal): string => ["h3", "p", "div"]
  .flatMap((tag) => root(modal).querySelectorAll(tag))
  .map((element) => element.textContent)
  .join(" ");
const button = (modal: DesktopIntegrationsModal, text: string): FakeElement | undefined =>
  root(modal).querySelectorAll("button").find((candidate) => candidate.textContent === text);

describe("DesktopIntegrationsModal", () => {
  it("explains that Companion works without MCP and offers connection recovery", () => {
    const controller = new Controller({ status: "ready", providerReady: false });
    const openConnectionSettings = vi.fn();
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      openConnectionSettings,
      openBridgeSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();

    expect(visibleText(modal)).toContain("Companion");
    expect(visibleText(modal)).toContain("do not require MCP");
    button(modal, "Open connection settings")?.dispatchEvent({ type: "click" });
    expect(openConnectionSettings).toHaveBeenCalledTimes(1);
    expect(controller.refresh).toHaveBeenCalledTimes(1);
  });

  it("renders ready Claude Code actions and exact setup disclosure", () => {
    const controller = new Controller({
      status: "ready",
      providerReady: true,
      inspection: {
        claude: { available: true, version: "2.1.226" },
        obsidian: { available: true, version: "1.12.7" },
        marketplaceInstalled: true,
        pluginInstalled: true,
        pluginEnabled: true,
      },
    });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    expect(visibleText(modal)).toContain("obsidian-agent@cavi");
    expect(visibleText(modal)).toContain("user scope");
    expect(button(modal, "Open terminal at vault")).toBeDefined();
  });

  it("passes explicit confirmation into Claude Code and Claude Desktop actions", () => {
    const controller = new Controller({ status: "ready", providerReady: true });
    controller.connectClaudeDesktop = vi.fn(async (confirmAction) => { await confirmAction(); });
    const confirm = vi.fn(async () => true);
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      confirm,
      claudeDesktopConfigPath: "/Users/me/Library/Application Support/Claude/claude_desktop_config.json",
    });
    modal.onOpen();
    button(modal, "Set up Claude Code")?.dispatchEvent({ type: "click" });
    button(modal, "Connect Claude Desktop")?.dispatchEvent({ type: "click" });
    expect(controller.setupClaudeCode).toHaveBeenCalledTimes(1);
    expect(controller.connectClaudeDesktop).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "claude-desktop",
      expect.stringContaining("/Users/me/Library/Application Support/Claude/claude_desktop_config.json"),
    );
  });

  it("shows progress and errors inline with accessible recovery", () => {
    const controller = new Controller({ status: "loading", providerReady: true, operation: "claude-code", message: "Installing…" });
    const openBridgeSettings = vi.fn();
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      openConnectionSettings: vi.fn(),
      openBridgeSettings,
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    const status = root(modal).querySelector('[role="status"]');
    expect(status?.textContent).toContain("Installing");
    expect(button(modal, "Set up Claude Code")?.disabled).toBe(true);
    expect(button(modal, "Connect Claude Desktop")?.disabled).toBe(false);

    controller.emit({
      status: "error",
      providerReady: true,
      error: { message: "Port 22360 is in use", recovery: "open-bridge-settings" },
    });
    expect(root(modal).querySelector('[role="alert"]')?.querySelector("p")?.textContent).toContain("Port 22360");
    button(modal, "Open bridge settings")?.dispatchEvent({ type: "click" });
    expect(openBridgeSettings).toHaveBeenCalledTimes(1);
  });

  it("renders explanation only on mobile and never starts desktop inspection", () => {
    const controller = new Controller({ status: "idle", providerReady: true });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: true,
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    expect(visibleText(modal)).toContain("desktop-only");
    expect(root(modal).querySelectorAll("button")).toHaveLength(0);
    expect(controller.refresh).not.toHaveBeenCalled();
  });

  it("disposes controller work when the modal closes", () => {
    const controller = new Controller({ status: "idle", providerReady: true });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    modal.onClose();
    expect(controller.listener).toBeNull();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});

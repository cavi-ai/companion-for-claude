import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { DesktopIntegrationViewState } from "../../src/integrations/desktopCoordinator";
import type { DesktopPlatform, ProbeResult } from "../../src/integrations/desktop";
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
      platform: "darwin",
      openConnectionSettings,
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
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
        claude: { available: true, state: "available", version: "2.1.226" },
        obsidian: { available: true, state: "available", version: "1.12.7" },
        marketplaceInstalled: true,
        pluginInstalled: true,
        pluginEnabled: true,
      },
    });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    expect(visibleText(modal)).toContain("obsidian-agent@cavi-ai");
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
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
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
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings,
      openObsidianCliSettings: vi.fn(),
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
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
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
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    modal.onClose();
    expect(controller.listener).toBeNull();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});

// Franco's report: the shim existed at /usr/local/bin/obsidian and the modal
// still said "not found", which reads as "install it" for something installed.
describe("DesktopIntegrationsModal CLI status", () => {
  const withObsidian = (obsidian: ProbeResult, platform: DesktopPlatform = "darwin") => {
    const controller = new Controller({
      status: "ready",
      providerReady: true,
      inspection: {
        claude: { available: true, state: "available", version: "2.1.226" },
        obsidian,
        marketplaceInstalled: true,
        pluginInstalled: true,
        pluginEnabled: true,
      },
    });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile: false,
      platform,
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings: vi.fn(),
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    return modal;
  };

  it("says an unreachable CLI is installed, and how to fix it", () => {
    const text = visibleText(withObsidian({ available: false, state: "unreachable", message: "unable to find Obsidian" }));
    expect(text).toContain("installed, not responding");
    expect(text).toContain("Restart Obsidian");
    expect(text).not.toContain("Obsidian CLI: not found");
  });

  it("says a missing CLI is not installed, and names the platform's target", () => {
    const text = visibleText(withObsidian({ available: false, state: "missing" }, "darwin"));
    expect(text).toContain("Obsidian CLI: not found");
    expect(text).toContain("Command line interface");
    expect(text).toContain("/usr/local/bin/obsidian");
  });

  it("shows the version and no remediation when the CLI answers", () => {
    const text = visibleText(withObsidian({ available: true, state: "available", version: "1.12.7" }));
    expect(text).toContain("Obsidian CLI: 1.12.7");
    expect(text).not.toContain("Restart Obsidian");
  });

  it("hides the terminal action while the CLI cannot answer", () => {
    expect(button(withObsidian({ available: false, state: "unreachable" }), "Open terminal at vault")).toBeUndefined();
  });
});

// Companion cannot install the CLI or place it on PATH — Obsidian's own switch
// and its elevated Register do both — so the modal routes the user there.
describe("DesktopIntegrationsModal CLI setup shortcut", () => {
  const open = (obsidian: ProbeResult, mobile = false) => {
    const openObsidianCliSettings = vi.fn();
    const controller = new Controller({
      status: "ready",
      providerReady: true,
      inspection: {
        claude: { available: true, state: "available", version: "2.1.226" },
        obsidian,
        marketplaceInstalled: true,
        pluginInstalled: true,
        pluginEnabled: true,
      },
    });
    const modal = new DesktopIntegrationsModal(new App(), {
      controller,
      mobile,
      platform: "darwin",
      openConnectionSettings: vi.fn(),
      openBridgeSettings: vi.fn(),
      openObsidianCliSettings,
      confirm: vi.fn(async () => true),
    });
    modal.onOpen();
    return { modal, openObsidianCliSettings };
  };

  it("offers the settings shortcut when the CLI is not installed", () => {
    const { modal, openObsidianCliSettings } = open({ available: false, state: "missing" });
    button(modal, "Open Obsidian CLI settings")?.dispatchEvent({ type: "click" });
    expect(openObsidianCliSettings).toHaveBeenCalledTimes(1);
  });

  it("offers it for an unreachable CLI too, where the switch is the re-register", () => {
    const { modal } = open({ available: false, state: "unreachable" });
    expect(button(modal, "Open Obsidian CLI settings")).toBeDefined();
  });

  it("names the register step, not an install Companion cannot do", () => {
    const { modal } = open({ available: false, state: "missing" });
    const text = visibleText(modal);
    expect(text).toContain("Set up CLI to work in the terminal");
    expect(text).toContain("Register");
  });

  it("hides the shortcut once the CLI answers", () => {
    const { modal } = open({ available: true, state: "available", version: "1.12.7" });
    expect(button(modal, "Open Obsidian CLI settings")).toBeUndefined();
  });

  it("hides the shortcut on mobile, which has no CLI", () => {
    const { modal } = open({ available: false, state: "missing" }, true);
    expect(button(modal, "Open Obsidian CLI settings")).toBeUndefined();
  });
});

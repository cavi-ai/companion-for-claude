import { App, FakeElement, fakeDocument, getLastOpenedModal, Platform, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";
import { conversationFakes } from "../fakes/conversations";
import { ActionModal } from "../../src/view/ActionModal";

/** Same shape as chatRenderLifecycle.test.ts's desktop-header plugin stub, reused for onOpen()-driven header tests. */
function headerPlugin(fakes = conversationFakes()): ClaudeCompanionPlugin {
  const app = new App();
  (app.workspace as unknown as { getActiveViewOfType(): null; getActiveFile(): null }).getActiveViewOfType = () => null;
  (app.workspace as unknown as { getActiveFile(): null }).getActiveFile = () => null;
  const chromeDeps: CompanionChromeDependencies = {
    app,
    activity: new ActivityStore(),
    snapshot: () => ({
      chatBackend: "claude", chatModel: DEFAULT_SETTINGS.model, agentModeEnabled: false, vaultContextEnabled: true,
      memoryIngestOnSave: false, utilityBackend: "claude", sourceEnrichOnCreate: true,
      sourceInboxFolder: "Clippings", sourceCaptureEnabled: false, clipperStatus: "not-set-up",
      semanticEnabled: true, embeddingEngine: "builtin", embeddingModel: "EmbeddingGemma",
      embeddingHealth: "Ready", indexHealth: "Ready", memoryEnabled: true, memoryFolder: "Memory",
      memoryAutoConsolidate: true, discoveryEnabled: true, researchModel: "chat",
    }),
    save: vi.fn(),
    run: vi.fn(),
    openAllSettings: vi.fn(),
    openDesktopIntegrations: vi.fn(),
  };
  return {
    app,
    settings: fakes.settings,
    router: () => ({
      chatBackend: "claude",
      anthropic: { hasCredentials: () => true },
      claudeCli: { hasCredentials: () => false },
      chatCapabilities: () => ({ agentActions: false, claudeControls: true, metered: true, local: false, cli: false }),
      chatToolCapable: async () => false,
      chatReasoningActive: async () => false,
      chatProvider: () => ({ provider: { id: "anthropic" }, model: DEFAULT_SETTINGS.model }),
    }),
    mcpStats: () => ({ running: false, port: null, activeRequests: 0, handledRequests: 0 }),
    shell: () => ({ companionChrome: () => chromeDeps }),
    promptTemplates: async () => [],
    captureWebPage: () => undefined,
    ...fakes.host,
    secrets: () => ({ available: () => false }),
    composeSystemPrompt: () => "system",
    views: () => ({ companionWorkspaceContext: async () => null }),
  } as unknown as ClaudeCompanionPlugin;
}

async function openHeader(fakes = conversationFakes()): Promise<ChatView> {
  const plugin = headerPlugin(fakes);
  const view = new ChatView(new WorkspaceLeaf(plugin.app as unknown as App), plugin);
  (view as unknown as { containerEl: { style: { setProperty(name: string, value: string): void } } }).containerEl = {
    style: { setProperty: () => undefined },
  };
  await view.onOpen();
  return view;
}

describe("Desktop chat header polish", () => {
  it("restores the More trigger before opening the next modal", () => {
    const trigger = new FakeElement("button");
    trigger.focus();
    let active: unknown;
    const modal = new ActionModal(new App(), "Actions", [{ title: "Quick options…", run: () => { active = fakeDocument.activeElement; } }]);
    modal.open();
    const option = (modal.contentEl as unknown as FakeElement).querySelector("button")!;
    option.focus();
    option.dispatchEvent({ type: "click" });
    expect(active).toBe(trigger);
  });
  it("keeps title and Sessions selection bound to this leaf across global active changes and rename", async () => {
    const alpha = { id: "a", title: "Alpha", createdAt: 1, updatedAt: 2, messages: [] };
    const beta = { id: "b", title: "Beta", createdAt: 1, updatedAt: 3, messages: [] };
    const fakes = conversationFakes({ conversations: [alpha, beta], activeId: "b" });
    const view = await openHeader(fakes);
    view.loadConversation(alpha);
    const root = view.contentEl as unknown as FakeElement;
    expect(root.querySelector(".cc-session-title")?.textContent).toBe("Alpha");
    await fakes.conversations.rename("a", "Renamed Alpha");
    view.refreshModelLabel();
    expect(root.querySelector(".cc-session-title")?.textContent).toBe("Renamed Alpha");
    expect(view.getDisplayText()).toBe("Renamed Alpha");
    const header = (view as unknown as { header: { openHistory(): void; sessionDropdown: { options: { activeId(): string | null } } } }).header;
    header.openHistory();
    expect(header.sessionDropdown.options.activeId()).toBe("a");
    expect(fakes.conversations.getActive()?.id).toBe("b");
    view.clearChat();
    expect(root.querySelector(".cc-session-title")?.textContent).toBe("New chat");
    await view.onClose();
  });
  afterEach(() => {
    Platform.isMobile = false;
  });

  it("keeps session actions together and secondary controls outside the model button", async () => {
    const view = await openHeader();
    const headerActions = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions");
    expect(headerActions).toBeTruthy();
    const labels = headerActions?.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Sessions", "New chat", "More actions"]);
    expect(labels).not.toContain("Distill this chat");
    expect(headerActions?.querySelectorAll(".cc-mcp-btn").length).toBe(0);
  });

  it("keeps Sessions labeled beside the current leaf title", async () => {
    const view = await openHeader();
    const buttons = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions")?.querySelectorAll("button") ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.find(button => button.getAttribute("aria-label") === "Sessions")?.querySelector(".cc-sessions-label")?.textContent).toBe("Sessions");
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-session-title")?.textContent).toBe("New chat");
  });

  it("the history button opens the session dropdown under it and a second click closes it", async () => {
    const body = new FakeElement("body");
    const g = globalThis as Record<string, unknown>;
    g.activeDocument = Object.assign(new FakeElement("document"), { body });
    g.activeWindow = { innerWidth: 1000 };
    try {
      const view = await openHeader(conversationFakes({ conversations: [{ id: "a", title: "Alpha", createdAt: 1, updatedAt: Date.now(), messages: [] }] }));
      const pane = view.contentEl as unknown as FakeElement;
      pane.rect = { left: 0, right: 420, top: 0, bottom: 800, width: 420, height: 800 };
      pane.querySelector(".cc-composer")!.rect = { left: 0, right: 420, top: 650, bottom: 800, width: 420, height: 150 };
      const history = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions")!.querySelectorAll("button")
        .find((b) => b.getAttribute("aria-label") === "Sessions")!;
      history.rect = { left: 100, right: 130, top: 10, bottom: 34, width: 30, height: 24 };
      history.dispatchEvent({ type: "click" });
      const dropdown = pane.querySelector(".cc-session-dropdown");
      expect(dropdown?.style.top).toBe("38px");
      expect(dropdown?.querySelectorAll(".cc-session-row")).toHaveLength(1);
      history.dispatchEvent({ type: "click" });
      expect(pane.querySelector(".cc-session-dropdown")).toBeNull();
    } finally {
      g.activeDocument = {};
      g.activeWindow = globalThis;
    }
  });

  it("clicking cc-model opens the model menu", async () => {
    const view = await openHeader();
    const openModelMenu = vi.fn();
    (view as unknown as { openModelMenu: () => void }).openModelMenu = openModelMenu;
    const modelChip = (view.contentEl as unknown as FakeElement).querySelector(".cc-model");
    expect(modelChip).toBeTruthy();
    modelChip?.dispatchEvent({ type: "click", stopPropagation: () => undefined });
    expect(openModelMenu).toHaveBeenCalledOnce();
  });

  it("uses a native model button and a separate MCP action", async () => {
    const view = await openHeader();
    const openModelMenu = vi.fn();
    const openMcpMenu = vi.fn();
    (view as unknown as { openModelMenu: () => void }).openModelMenu = openModelMenu;
    (view as unknown as { openMcpMenu: (a: unknown) => void }).openMcpMenu = openMcpMenu;
    const modelChip = (view.contentEl as unknown as FakeElement).querySelector(".cc-model");
    expect(modelChip?.tagName).toBe("BUTTON");
    expect(modelChip?.querySelector("button")).toBeNull();
    const dot = (view.contentEl as unknown as FakeElement).querySelector(".cc-mcp-dot");
    expect(dot).toBeTruthy();
    dot?.dispatchEvent({ type: "click", stopPropagation: () => undefined });
    expect(openMcpMenu).toHaveBeenCalledOnce();
    expect(openModelMenu).not.toHaveBeenCalled();
  });

  it("overflow menu includes Distill this chat, MCP bridge…, and Capture a Claude Code session… when memoryEnabled", () => {
    const plugin = headerPlugin();
    plugin.settings.memoryEnabled = true;
    const view = new ChatView(new WorkspaceLeaf(plugin.app as unknown as App), plugin);

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();

    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    const titles = content.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));
    expect(titles).toContain("Distill this chat");
    expect(titles).not.toContain("Save chat to vault");
    expect(titles).toContain("MCP bridge…");
    expect(titles).toContain("Capture a Claude Code session…");
  });

  it("mobile keeps labeled Sessions and More without desktop-only MCP", async () => {
    Platform.isMobile = true;
    const view = await openHeader();
    const headerActions = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions");
    const more = headerActions?.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "More actions");
    expect(more).toBeTruthy();
    expect(more?.getAttribute("data-icon")).toBe("more-vertical");
    expect(headerActions?.querySelector(".cc-sessions-btn")).toBeTruthy();
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-mcp-dot")).toBeNull();
  });

  it("pins the chat above the keyboard on mobile only, and stops when the view closes", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const desktop = await openHeader();
    expect(add).not.toHaveBeenCalledWith("scroll", expect.any(Function), true);
    await desktop.onClose();
    Platform.isMobile = true;
    const view = await openHeader();
    expect(add).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    await view.onClose();
    expect(remove).toHaveBeenCalledWith("scroll", add.mock.calls.find((call) => call[0] === "scroll")![1], true);
  });

  it("renders a user message inside .cc-msg.cc-user with the accessible .cc-role label present", () => {
    const plugin = { settings: structuredClone(DEFAULT_SETTINGS) } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const messagesEl = new FakeElement();
    const seam = view as unknown as {
      messagesEl: HTMLElement;
      renderStoredMessage(message: { role: "user"; content: string }): void;
    };
    seam.messagesEl = messagesEl as unknown as HTMLElement;

    seam.renderStoredMessage({ role: "user", content: "Hello there" });

    const bubble = messagesEl.querySelector(".cc-user");
    expect(bubble).toBeTruthy();
    expect(bubble?.classList.has("cc-msg")).toBe(true);
    expect(bubble?.querySelector(".cc-role")).toBeTruthy();
  });
});

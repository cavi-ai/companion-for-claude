import { App, FakeElement, getLastOpenedModal, Platform, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";

/** Same shape as chatRenderLifecycle.test.ts's desktop-header plugin stub, reused for onOpen()-driven header tests. */
function headerPlugin(): ClaudeCompanionPlugin {
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
      memoryAutoConsolidate: true, discoveryEnabled: true, discoveryReranker: "current",
    }),
    save: vi.fn(),
    run: vi.fn(),
    openAllSettings: vi.fn(),
    openDesktopIntegrations: vi.fn(),
  };
  return {
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
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
    companionChrome: () => chromeDeps,
    promptTemplates: async () => [],
    getActiveConversation: () => null,
    secrets: () => ({ available: () => false }),
    composeSystemPrompt: () => "system",
    companionWorkspaceContext: async () => null,
  } as unknown as ClaudeCompanionPlugin;
}

async function openHeader(): Promise<ChatView> {
  const plugin = headerPlugin();
  const view = new ChatView(new WorkspaceLeaf(plugin.app as unknown as App), plugin);
  (view as unknown as { containerEl: { style: { setProperty(name: string, value: string): void } } }).containerEl = {
    style: { setProperty: () => undefined },
  };
  await view.onOpen();
  return view;
}

describe("Desktop chat header polish", () => {
  afterEach(() => {
    Platform.isMobile = false;
  });

  it("has exactly New chat / Resume / More actions + quick options, no Save button and no cc-mcp-btn", async () => {
    const view = await openHeader();
    const headerActions = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions");
    expect(headerActions).toBeTruthy();
    const labels = headerActions?.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["New chat", "Resume a past conversation", "More actions", "Quick options for Chat"]);
    expect(labels).not.toContain("Save chat to vault");
    expect(headerActions?.querySelectorAll(".cc-mcp-btn").length).toBe(0);
  });

  it("renders every header action as an Obsidian ghost icon button", async () => {
    const view = await openHeader();
    const buttons = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions")?.querySelectorAll("button") ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.classList.has("clickable-icon")).toBe(true);
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

  it("has a cc-mcp-dot inside cc-model that calls openMcpMenu, not openModelMenu, on click", async () => {
    const view = await openHeader();
    const openModelMenu = vi.fn();
    const openMcpMenu = vi.fn();
    (view as unknown as { openModelMenu: () => void }).openModelMenu = openModelMenu;
    (view as unknown as { openMcpMenu: (a: unknown) => void }).openMcpMenu = openMcpMenu;
    const modelChip = (view.contentEl as unknown as FakeElement).querySelector(".cc-model");
    const dot = modelChip?.querySelector(".cc-mcp-dot");
    expect(dot).toBeTruthy();
    dot?.dispatchEvent({ type: "click", stopPropagation: () => undefined });
    expect(openMcpMenu).toHaveBeenCalledOnce();
    expect(openModelMenu).not.toHaveBeenCalled();
  });

  it("overflow menu includes Save chat to vault, MCP bridge…, and Capture a Claude Code session… when memoryEnabled", () => {
    const plugin = headerPlugin();
    plugin.settings.memoryEnabled = true;
    const view = new ChatView(new WorkspaceLeaf(plugin.app as unknown as App), plugin);

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();

    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    const titles = content.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));
    expect(titles).toContain("Save chat to vault");
    expect(titles).toContain("MCP bridge…");
    expect(titles).toContain("Capture a Claude Code session…");
  });

  it("mobile header is unchanged: more-vertical button present, no cc-mcp-dot", async () => {
    Platform.isMobile = true;
    const view = await openHeader();
    const headerActions = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions");
    const more = headerActions?.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "More actions");
    expect(more).toBeTruthy();
    expect(more?.getAttribute("data-icon")).toBe("more-vertical");
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-mcp-dot")).toBeNull();
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

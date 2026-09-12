import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { defaultChatControls } from "../../src/claude/chatControls";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";
import type { TurnRendererHost } from "../../src/view/turnRenderer";

const fakeElement = (): HTMLElement => new FakeElement() as unknown as HTMLElement;

// The shared FakeElement has no `.dataset` (real DOM elements do); ChatView's
// finishAssistant() uses it as an idempotency flag. Shim it per-instance so a
// full run() can be driven in a test without touching the shared fake.
const datasets = new WeakMap<object, Record<string, string>>();
Object.defineProperty(FakeElement.prototype, "dataset", {
  configurable: true,
  get(this: object) {
    let d = datasets.get(this);
    if (!d) {
      d = {};
      datasets.set(this, d);
    }
    return d;
  },
});

function renderingHost(renderMarkdownInto: TurnRendererHost["renderMarkdownInto"]): TurnRendererHost {
  return {
    renderMarkdownInto,
    renderStreamingArtifactInto: () => undefined,
    scrollToBottom: () => undefined,
    clearThinkingStatus: () => undefined,
    createThinkingPanel: () => fakeElement(),
    annotateTruncated: () => undefined,
    mergeTurnUsage: () => undefined,
    syncBuffer: () => undefined,
  };
}

describe("Chat render lifecycle", () => {
  it("persists the submitted turn before starting backend work", async () => {
    let releasePersist!: () => void;
    const persisted = new Promise<void>((resolve) => { releasePersist = resolve; });
    const stream = vi.fn(async (_request: unknown, handlers: { onDone(text: string): void }) => { handlers.onDone("answer"); });
    const provider = { id: "anthropic", hasCredentials: () => true, stream };
    const beginActiveConversationTurn = vi.fn(async () => {
      await persisted;
      return { conversationId: "conversation-1", turnId: "turn-1" };
    });
    const plugin = {
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        agentModeEnabled: false,
        context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
      },
      router: () => ({
        chatProvider: () => ({ provider, model: DEFAULT_SETTINGS.model }),
        chatBackend: "claude",
        chatCapabilities: () => ({ agentActions: false, claudeControls: true, metered: true, local: false, cli: false }),
        chatToolCapable: async () => false,
        anthropic: provider,
        claudeCli: { hasCredentials: () => false, available: () => false },
        localFallback: async () => null,
      }),
      beginActiveConversationTurn,
      registerActiveChatTurn: vi.fn(() => () => undefined),
      completeActiveConversationTurn: vi.fn(async () => undefined),
      interruptActiveConversationTurn: vi.fn(async () => undefined),
      composeSystemPrompt: () => "system",
      semanticSearch: async () => [],
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      app: { workspace: { getActiveViewOfType?: () => null; getActiveFile?: () => null } };
      controls: ReturnType<typeof defaultChatControls>;
      messagesEl: HTMLElement;
      sendBtn: HTMLButtonElement;
      usageEl: HTMLElement;
      gaugeFillEl: HTMLElement;
      renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void>;
      run(userText: string): Promise<void>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.messagesEl = fakeElement();
    seam.sendBtn = fakeElement() as unknown as HTMLButtonElement;
    seam.usageEl = fakeElement();
    seam.gaugeFillEl = fakeElement();
    seam.app.workspace.getActiveViewOfType = () => null;
    seam.app.workspace.getActiveFile = () => null;
    seam.renderMarkdownInto = async () => undefined;

    const running = seam.run("Research this");
    await Promise.resolve();

    expect(beginActiveConversationTurn).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();

    releasePersist();
    await running;
    expect(stream).toHaveBeenCalledOnce();
  });

  it("settles a successful provider turn as an error when its final markdown render rejects", async () => {
    const provider = {
      id: "anthropic",
      hasCredentials: () => true,
      stream: async (_request: unknown, handlers: { onDone(text: string): void }) => { handlers.onDone("answer"); },
    };
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      router: () => ({ anthropic: provider }),
      composeSystemPrompt: () => "system",
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const finishAssistant = vi.fn();
    const seam = view as unknown as {
      controls: ReturnType<typeof defaultChatControls>;
      turnHost(): TurnRendererHost;
      finishAssistant(text: string | null, bubble: HTMLElement): void;
      streamTurn(target: "claude", messages: [], bubble: HTMLElement, body: HTMLElement): Promise<{ message?: string } | null>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.turnHost = () => renderingHost(async () => { throw new Error("Markdown render failed"); });
    seam.finishAssistant = finishAssistant;

    const outcome = await Promise.race([
      seam.streamTurn("claude", [], fakeElement(), fakeElement()),
      new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(outcome).toEqual({ message: "Markdown render failed" });
    expect(finishAssistant).not.toHaveBeenCalled();
  });

  it("settles when a provider rejects instead of invoking a terminal callback", async () => {
    const provider = {
      id: "anthropic",
      hasCredentials: () => true,
      stream: async () => { throw new Error("transport crashed"); },
    };
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      router: () => ({ anthropic: provider }),
      composeSystemPrompt: () => "system",
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      controls: ReturnType<typeof defaultChatControls>;
      turnHost(): TurnRendererHost;
      streamTurn(target: "claude", messages: [], bubble: HTMLElement, body: HTMLElement): Promise<{ message?: string } | null>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.turnHost = () => renderingHost(async () => undefined);

    await expect(seam.streamTurn("claude", [], fakeElement(), fakeElement())).resolves.toEqual({ message: "transport crashed" });
  });

  it("returns an actionable agent-turn error when its final render rejects", async () => {
    const provider = {
      id: "anthropic",
      stream: async (_request: unknown, handlers: { onText(text: string): void }) => { handlers.onText("agent answer"); },
    };
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      router: () => ({ chatProvider: () => ({ provider, model: DEFAULT_SETTINGS.model }), chatCapabilities: () => ({ agentActions: true, claudeControls: true, metered: true, local: false, cli: false }) }),
      composeSystemPrompt: () => "system",
      externalMcpTools: async () => [],
      agentTools: () => ({ definitions: () => [], call: async () => "" }),
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      controls: ReturnType<typeof defaultChatControls>;
      turnHost(): TurnRendererHost;
      agentTurn(messages: [], bubble: HTMLElement, body: HTMLElement): Promise<{ message?: string } | null>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.turnHost = () => renderingHost(async () => { throw new Error("agent render failed"); });
    const originalAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);

    try {
      await expect(seam.agentTurn([], fakeElement(), fakeElement())).resolves.toEqual({ message: "agent render failed" });
    } finally {
      window.requestAnimationFrame = originalAnimationFrame;
    }
  });

  it("falls back to readable text when one stored message cannot render as markdown", async () => {
    const plugin = { settings: structuredClone(DEFAULT_SETTINGS) } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const messagesEl = fakeElement();
    const seam = view as unknown as {
      messagesEl: HTMLElement;
      renderMarkdownInto(element: HTMLElement, markdown: string): Promise<void>;
      renderStoredMessage(message: { role: "assistant"; content: string }): void;
    };
    seam.messagesEl = messagesEl;
    seam.renderMarkdownInto = async () => { throw new Error("renderer unavailable"); };

    seam.renderStoredMessage({ role: "assistant", content: "Still readable" });
    await Promise.resolve();
    await Promise.resolve();

    expect(messagesEl.querySelector(".cc-body")?.textContent).toBe("Still readable");
  });

  it("names the local provider that actually failed, not always Ollama, in the fallback error hint", async () => {
    const failing = (message: string) => async (): Promise<never> => {
      const err = new Error(message) as Error & { status?: number };
      err.status = 503;
      throw err;
    };
    const claudeProvider = { id: "anthropic", hasCredentials: () => true, stream: failing("fetch failed") };
    const endpointProvider = { id: "openai-compat", hasCredentials: () => true, stream: failing("fetch failed") };
    const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "auto" as const, agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } };
    const plugin = {
      settings,
      router: () => ({
        chatProvider: () => ({ provider: claudeProvider, model: "claude-model" }),
        chatBackend: "auto",
        chatCapabilities: () => ({ agentActions: false, claudeControls: true, metered: true, local: false, cli: false }),
        chatToolCapable: async () => false,
        anthropic: claudeProvider,
        claudeCli: { hasCredentials: () => false, available: () => false },
        localFallback: async () => ({ provider: endpointProvider, model: "local-model" }),
      }),
      composeSystemPrompt: () => "system",
      semanticSearch: async () => [],
      beginActiveConversationTurn: vi.fn(async () => ({ conversationId: "conversation-1", turnId: "turn-1" })),
      registerActiveChatTurn: vi.fn(() => () => undefined),
      completeActiveConversationTurn: vi.fn(async () => undefined),
      interruptActiveConversationTurn: vi.fn(async () => undefined),
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      app: { workspace: { getActiveViewOfType?: () => null; getActiveFile?: () => null } };
      controls: ReturnType<typeof defaultChatControls>;
      messagesEl: HTMLElement;
      sendBtn: HTMLButtonElement;
      usageEl: HTMLElement;
      gaugeFillEl: HTMLElement;
      renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void>;
      run(userText: string): Promise<void>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.messagesEl = fakeElement();
    seam.sendBtn = fakeElement() as unknown as HTMLButtonElement;
    seam.usageEl = fakeElement();
    seam.gaugeFillEl = fakeElement();
    // The fake App's workspace doesn't implement view/file lookups; this test
    // has every context toggle off, so gatherContext only needs them present.
    seam.app.workspace.getActiveViewOfType = () => null;
    seam.app.workspace.getActiveFile = () => null;
    // Bypass Obsidian's real MarkdownRenderer (unavailable in this fake env).
    seam.renderMarkdownInto = async () => undefined;

    await seam.run("Summarize my vault in one line.");

    const errorBox = (seam.messagesEl as unknown as FakeElement).querySelector(".cc-error");
    const hint = errorBox?.querySelector(".cc-error-hint")?.textContent ?? "";
    expect(hint).not.toMatch(/ollama/i);
    expect(hint).toMatch(/openai-compatible endpoint/i);
    expect(hint).toMatch(/host/i);
  });

  it("splits the desktop header into a one-shot action group and a stateful toggle group", async () => {
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
    const plugin = {
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
    const view = new ChatView(new WorkspaceLeaf(app), plugin);
    (view as unknown as { containerEl: { style: { setProperty(name: string, value: string): void } } }).containerEl = {
      style: { setProperty: () => undefined },
    };

    await view.onOpen();

    const headerActions = (view.contentEl as unknown as FakeElement).querySelector(".cc-header-actions");
    expect(headerActions).toBeTruthy();
    expect(headerActions?.querySelector(".cc-actions-sep")).toBeNull();

    const primary = headerActions?.querySelector(".cc-header-actions-primary");
    expect(primary).toBeTruthy();
    expect(primary?.querySelectorAll("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "New chat",
      "Resume a past conversation",
      "Save chat to vault",
      "Capture a Claude Code session into memory",
    ]);

    const state = headerActions?.querySelector(".cc-header-actions-state");
    expect(state).toBeTruthy();
    // aria-label is rewritten to reflect live bridge status right after mount
    // (refreshContextStatus), so identify the MCP button by its stable class.
    expect(state?.querySelectorAll(".cc-mcp-btn").length).toBe(1);
    expect(primary?.querySelectorAll(".cc-mcp-btn").length).toBe(0);
  });
});

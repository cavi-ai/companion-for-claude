import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import type { AgentTurnHandlers } from "../../src/agent/loop";
import { ChatTurnService } from "../../src/chat/turnService";
import { defaultChatControls } from "../../src/claude/chatControls";
import type { Conversation } from "../../src/conversations/store";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";

const fakeElement = (): HTMLElement => new FakeElement() as unknown as HTMLElement;

// The shared FakeElement has no `.dataset` (real DOM elements do); ChatView's
// settleTurnRendering() uses it as an idempotency flag. Shim it per-instance so
// a full run() can be driven in a test without touching the shared fake.
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

// TurnRenderer schedules its throttled flush via window.requestAnimationFrame
// (src/view/turnRenderer.ts); the node test env has no DOM, so stub it as
// test/view/turnRenderer.test.ts does.
let rafQueue: Array<() => void>;

beforeEach(() => {
  rafQueue = [];
  window.requestAnimationFrame = ((cb: () => void) => (rafQueue.push(cb), rafQueue.length)) as typeof window.requestAnimationFrame;
});

afterEach(() => {
  delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
});

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
      turnService: () => new ChatTurnService(),
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

  it("keeps a turn running (and persisting) after the view closes, and replays it once on reopen", async () => {
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    let releaseRest!: (text: string) => void;
    const rest = new Promise<string>((resolve) => { releaseRest = resolve; });
    const stream = vi.fn(async (_request: unknown, h: { onText(t: string): void; onDone(t: string): void }) => {
      h.onText("Hel");
      streamStarted(); // buffered before we close mid-turn below
      h.onText(await rest);
      h.onDone("Hello");
    });
    const provider = { id: "anthropic", hasCredentials: () => true, stream };
    const turnService = new ChatTurnService();
    const completeActiveConversationTurn = vi.fn(async () => undefined);
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
      beginActiveConversationTurn: vi.fn(async () => ({ conversationId: "conversation-1", turnId: "turn-1" })),
      registerActiveChatTurn: vi.fn(() => () => undefined),
      completeActiveConversationTurn,
      interruptActiveConversationTurn: vi.fn(async () => undefined),
      composeSystemPrompt: () => "system",
      semanticSearch: async () => [],
      turnService: () => turnService,
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
      onClose(): Promise<void>;
      loadConversation(conversation: Conversation): void;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    seam.messagesEl = fakeElement();
    seam.sendBtn = fakeElement() as unknown as HTMLButtonElement;
    seam.usageEl = fakeElement();
    seam.gaugeFillEl = fakeElement();
    seam.app.workspace.getActiveViewOfType = () => null;
    seam.app.workspace.getActiveFile = () => null;
    seam.renderMarkdownInto = async () => undefined;

    const running = seam.run("Hello");
    await started;

    // Close mid-turn: unsubscribes, does not stop the turn.
    await seam.onClose();
    expect(completeActiveConversationTurn).not.toHaveBeenCalled();
    expect(turnService.live("conversation-1")).not.toBeNull();

    // Reopen on the same conversation: replay the buffered text, then stream live.
    seam.messagesEl = fakeElement();
    seam.loadConversation({
      id: "conversation-1",
      messages: [{ role: "user", content: "Hello" }],
      activeTurn: { id: "turn-1", state: "running" },
    } as unknown as Conversation);

    releaseRest("lo");
    await running;
    // settleTurnRendering (DOM-only) is fire-and-forget relative to handle.result
    // (persistence) — flush its short renderer.finalize() chain before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(completeActiveConversationTurn).toHaveBeenCalledOnce();
    expect(completeActiveConversationTurn.mock.calls[0]?.[2]).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hello" },
    ]);
    const assistantBubbles = (seam.messagesEl as unknown as FakeElement).querySelectorAll(".cc-assistant");
    expect(assistantBubbles.length).toBe(1);
  });

  it("streamTurn resolves an AgentTurnResult (never rejects) when the provider stream rejects", async () => {
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
      streamTurn(target: "claude", messages: [], handlers: AgentTurnHandlers, signal: AbortSignal): Promise<{ text: string; trace: unknown[]; error?: Error }>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    const handlers: AgentTurnHandlers = { onText: vi.fn() };

    const result = await seam.streamTurn("claude", [], handlers, new AbortController().signal);

    expect(result.text).toBe("");
    expect(result.error?.message).toBe("transport crashed");
  });

  it("streamTurn resolves with the streamed text and no error when the provider succeeds", async () => {
    const provider = {
      id: "anthropic",
      hasCredentials: () => true,
      stream: async (_request: unknown, h: { onDone(text: string): void }) => { h.onDone("answer"); },
    };
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      router: () => ({ anthropic: provider }),
      composeSystemPrompt: () => "system",
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      controls: ReturnType<typeof defaultChatControls>;
      streamTurn(target: "claude", messages: [], handlers: AgentTurnHandlers, signal: AbortSignal): Promise<{ text: string; trace: unknown[]; error?: Error }>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    const handlers: AgentTurnHandlers = { onText: vi.fn() };

    const result = await seam.streamTurn("claude", [], handlers, new AbortController().signal);

    expect(result).toEqual({ text: "answer", trace: [] });
  });

  it("agentTurn resolves an AgentTurnResult error when building the turn runner throws", async () => {
    const provider = { id: "anthropic", stream: async () => undefined };
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      router: () => ({
        chatProvider: () => ({ provider, model: DEFAULT_SETTINGS.model }),
        chatCapabilities: () => { throw new Error("router unavailable"); },
      }),
      composeSystemPrompt: () => "system",
      externalMcpTools: async () => [],
      agentTools: () => ({ definitions: () => [], call: async () => "" }),
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const seam = view as unknown as {
      controls: ReturnType<typeof defaultChatControls>;
      agentTurn(messages: [], handlers: AgentTurnHandlers, signal: AbortSignal): Promise<{ text: string; trace: unknown[]; error?: Error }>;
    };
    seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
    const handlers: AgentTurnHandlers = { onText: vi.fn() };

    const result = await seam.agentTurn([], handlers, new AbortController().signal);

    expect(result.text).toBe("");
    expect(result.error?.message).toBe("router unavailable");
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
      turnService: () => new ChatTurnService(),
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

  it("renders the calm desktop header: 3 ghost icons plus quick options, no state group", async () => {
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

    // Save, session capture, the ingest toggle, and the MCP button all moved out
    // of the header (into the model chip's MCP dot or the overflow menu).
    const primary = headerActions?.querySelector(".cc-header-actions-primary");
    expect(primary).toBeTruthy();
    expect(primary?.querySelectorAll("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "New chat",
      "Resume a past conversation",
      "More actions",
      "Quick options for Chat",
    ]);
    expect(headerActions?.querySelector(".cc-header-actions-state")).toBeNull();
    expect(headerActions?.querySelectorAll(".cc-mcp-btn").length).toBe(0);
  });
});

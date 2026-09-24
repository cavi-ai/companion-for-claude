import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTurnService } from "../../src/chat/turnService";
import { defaultChatControls } from "../../src/claude/chatControls";
import type { Conversation } from "../../src/conversations/store";
import type { ChatProject } from "../../src/projects/model";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";

const fakeElement = (): HTMLElement => new FakeElement() as unknown as HTMLElement;

// The shared FakeElement has no `.dataset` (real DOM elements do); ChatView's
// settleTurnRendering() uses it as an idempotency flag. Shim it (see
// chatRenderLifecycle.test.ts) so run() can complete a turn in this file too.
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

let rafQueue: Array<() => void>;

beforeEach(() => {
  rafQueue = [];
  window.requestAnimationFrame = ((cb: () => void) => (rafQueue.push(cb), rafQueue.length)) as typeof window.requestAnimationFrame;
});

afterEach(() => {
  delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
});

/** A minimal plugin stub, shaped like chatRenderLifecycle.test.ts's, plus the
 * conversation-store surface getState/setState/clearChat touch. */
function statePlugin(overrides: Partial<Record<string, unknown>> = {}): ClaudeCompanionPlugin {
  const provider = { id: "anthropic", hasCredentials: () => true };
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    router: () => ({
      chatProvider: () => ({ provider, model: DEFAULT_SETTINGS.model }),
      chatBackend: "claude",
      chatCapabilities: () => ({ agentActions: false, claudeControls: true, metered: true, local: false, cli: false }),
    }),
    composeSystemPrompt: () => "system",
    listConversations: () => [],
    turnService: () => ({ live: () => null }),
    startNewConversation: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ClaudeCompanionPlugin;
}

/** Seam type for the private fields/methods these tests poke, mirroring the
 * cast pattern chatRenderLifecycle.test.ts and chatActivation.test.ts use. */
interface Seam {
  app: { workspace: { getActiveViewOfType?: () => null; getActiveFile?: () => null } };
  controls: ReturnType<typeof defaultChatControls>;
  messagesEl: HTMLElement;
  sendBtn: HTMLButtonElement;
  usageEl: HTMLElement;
  gaugeFillEl: HTMLElement;
  conversationId: string | null;
  renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void>;
  renderEmptyState(): void;
  getState(): Record<string, unknown>;
  setState(state: unknown, result: unknown): Promise<void>;
  clearChat(): void;
}

function buildView(plugin: ClaudeCompanionPlugin): Seam {
  const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
  const seam = view as unknown as Seam;
  seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
  seam.messagesEl = fakeElement();
  seam.sendBtn = fakeElement() as unknown as HTMLButtonElement;
  seam.usageEl = fakeElement();
  seam.gaugeFillEl = fakeElement();
  seam.app.workspace.getActiveViewOfType = () => null;
  seam.app.workspace.getActiveFile = () => null;
  seam.renderMarkdownInto = async () => undefined;
  // clearChat's empty-state render pulls in the setup-card/credential chain;
  // that path isn't what this file is about, so it's stubbed to a no-op.
  seam.renderEmptyState = () => undefined;
  return seam;
}

describe("ChatView per-leaf conversation state", () => {
  it("getState/setState round trip: a known id loads that conversation and is reflected back", async () => {
    const conversation: Conversation = { id: "b", title: "Release notes", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({ listConversations: () => [conversation] }));

    await seam.setState({ conversationId: "b" }, {});

    expect(seam.conversationId).toBe("b");
    expect(seam.getState()).toEqual({ conversationId: "b" });
  });

  it("setState with an unknown id keeps the current state", async () => {
    const known: Conversation = { id: "known", title: "T", createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({ listConversations: () => [known] }));
    seam.conversationId = "known";

    await seam.setState({ conversationId: "ghost-id" }, {});

    expect(seam.conversationId).toBe("known");
    expect(seam.getState()).toEqual({ conversationId: "known" });
  });

  it("clearChat nulls the conversation id without touching the store's active id", () => {
    const startNewConversation = vi.fn(async () => undefined);
    const seam = buildView(statePlugin({ startNewConversation }));
    seam.conversationId = "existing";

    seam.clearChat();

    expect(seam.conversationId).toBeNull();
    expect(startNewConversation).not.toHaveBeenCalled();
  });

  it("loadConversation calls the leaf's updateHeader when present, so the tab title follows the active conversation", () => {
    const conversation: Conversation = { id: "b", title: "Release notes", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({ listConversations: () => [conversation] }));
    const updateHeader = vi.fn();
    (seam as unknown as { leaf: { updateHeader: () => void } }).leaf.updateHeader = updateHeader;

    (seam as unknown as { loadConversation(c: Conversation): void }).loadConversation(conversation);

    expect(updateHeader).toHaveBeenCalledOnce();
  });

  it("picking a project on an unstarted tab creates no conversation; the first turn persists the projectId", async () => {
    const project: ChatProject = { id: "Claude/Projects/Launch.md", name: "Launch", folder: null, pinned: [], instructions: "Ship it.", source: "note" };
    const stream = vi.fn(async (_request: unknown, handlers: { onDone(text: string): void }) => { handlers.onDone("answer"); });
    const provider = { id: "anthropic", hasCredentials: () => true, stream };
    const setChatProject = vi.fn(async () => undefined);
    const beginActiveConversationTurn = vi.fn(async () => ({ conversationId: "conversation-1", turnId: "turn-1" }));
    const plugin = statePlugin({
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
      semanticSearch: async () => [],
      turnService: () => new ChatTurnService(),
      setChatProject,
      chatProjectFor: async () => project,
    });
    const seam = buildView(plugin) as unknown as Seam & {
      applyChosenProject(p: ChatProject): Promise<void>;
      run(userText: string): Promise<void>;
      pendingProjectId: string | null;
    };

    await seam.applyChosenProject(project);

    expect(setChatProject).not.toHaveBeenCalled();
    expect(seam.pendingProjectId).toBe(project.id);
    expect(seam.conversationId).toBeNull();

    await seam.run("Hello");

    expect(beginActiveConversationTurn).toHaveBeenCalledOnce();
    expect(setChatProject).toHaveBeenCalledOnce();
    expect(setChatProject).toHaveBeenCalledWith("conversation-1", project.id);
    expect(seam.pendingProjectId).toBeNull();
  });
});

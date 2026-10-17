import { App, FakeElement, getLastOpenedModal, WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTurnService } from "../../src/chat/turnService";
import { defaultChatControls } from "../../src/claude/chatControls";
import type { Conversation } from "../../src/conversations/store";
import type { ChatProject } from "../../src/projects/model";
import type { MediaAttachment } from "../../src/context/attachments";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import { conversationFakes } from "../fakes/conversations";

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
function statePlugin(overrides: Partial<Record<string, unknown>> = {}, fakes = conversationFakes()): ClaudeCompanionPlugin {
  const provider = { id: "anthropic", hasCredentials: () => true };
  return {
    settings: fakes.settings,
    router: () => ({
      chatProvider: () => ({ provider, model: DEFAULT_SETTINGS.model }),
      chatBackend: "claude",
      chatCapabilities: () => ({ agentActions: false, claudeControls: true, metered: true, local: false, cli: false }),
    }),
    composeSystemPrompt: () => "system",
    ...fakes.host,
    turnService: () => ({ live: () => null }),
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
  renderer: { renderInto(el: HTMLElement, markdown: string): Promise<void> };
  renderEmptyState(): void;
  getState(): Record<string, unknown>;
  setState(state: unknown, result: unknown): Promise<void>;
  clearChat(): void;
  contextToggles: { activeNote: boolean; selection: boolean; linkedNotes: boolean; searchVault: boolean };
  attachedPaths: Array<{ path: string; kind: "note" | "folder" }>;
  inputEl: { value: string; focus(): void };
  composer: { autosizeInput(): void };
  resolveMarkdownContextView(): { file: { path: string } } | null;
  toggleAutomaticContext(key: "activeNote" | "selection" | "linkedNotes" | "searchVault", enabled: boolean): void;
  loadConversation(c: Conversation): void;
  prepareWorkspaceQuestion(workspace: { kind: "research" | "note"; title: string; contextPath: string }): void;
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
  seam.renderer.renderInto =async () => undefined;
  // clearChat's empty-state render pulls in the setup-card/credential chain;
  // that path isn't what this file is about, so it's stubbed to a no-op.
  seam.renderEmptyState = () => undefined;
  return seam;
}

describe("ChatView per-leaf conversation state", () => {
  function mediaView() {
    return buildView(statePlugin()) as Seam & {
      attachedMedia: MediaAttachment[];
      composer: { attachPastedImage(file: File): Promise<void> };
    };
  }

  it("New chat clears both pasted images and pending vault PDFs", () => {
    const seam = mediaView();
    seam.attachedMedia = [
      { kind: "image", label: "chart.png", mime: "image/png", data: "image-data" },
      { kind: "pdf", label: "Study.pdf", mime: "application/pdf", path: "Study.pdf" },
    ];
    seam.clearChat();
    expect(seam.attachedMedia).toEqual([]);
  });

  it("ignores a paste read that finishes after New chat, while allowing a fresh paste", async () => {
    const seam = mediaView();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    let finish!: (buffer: ArrayBuffer) => void;
    const read = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const oldFile = { name: "old-chart.png", size: 4, type: "image/png", arrayBuffer: () => read } as File;
    const pending = seam.composer.attachPastedImage(oldFile);
    seam.clearChat();
    finish(bytes);
    await pending;
    expect(seam.attachedMedia).toEqual([]);

    await seam.composer.attachPastedImage({ ...oldFile, name: "new-chart.png", arrayBuffer: async () => bytes } as File);
    expect(seam.attachedMedia).toEqual([expect.objectContaining({ label: "new-chart.png", kind: "image", mime: "image/png" })]);
  });

  const draftConversation = (id: string): Conversation => ({ id, title: id, createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: id }] });

  function draftView(): Seam {
    const seam = buildView(statePlugin({}, conversationFakes({ conversations: [draftConversation("a"), draftConversation("b")] })));
    seam.inputEl = { value: "", focus: () => undefined };
    seam.composer.autosizeInput = () => undefined;
    return seam;
  }

  it("restores separate drafts when history switches between conversations", () => {
    const seam = draftView();
    seam.loadConversation(draftConversation("a"));
    seam.inputEl.value = "Release follow-up\nKeep the original wording.  ";
    seam.loadConversation(draftConversation("b"));
    expect(seam.inputEl.value).toBe("");
    seam.inputEl.value = "Pilot follow-up";
    seam.loadConversation(draftConversation("a"));
    expect(seam.inputEl.value).toBe("Release follow-up\nKeep the original wording.  ");
    seam.loadConversation(draftConversation("b"));
    expect(seam.inputEl.value).toBe("Pilot follow-up");
  });

  it("preserves an independent new-chat draft across conversation navigation", () => {
    const seam = draftView();
    seam.inputEl.value = "Unsent new chat";
    seam.loadConversation(draftConversation("a"));
    expect(seam.inputEl.value).toBe("");
    seam.inputEl.value = "Existing chat follow-up";
    seam.clearChat();
    expect(seam.inputEl.value).toBe("Unsent new chat");
    seam.loadConversation(draftConversation("a"));
    expect(seam.inputEl.value).toBe("Existing chat follow-up");
  });

  it("switches drafts through Obsidian view state without overwriting their owner", async () => {
    const seam = draftView();
    await seam.setState({ conversationId: "a" }, {});
    seam.inputEl.value = "A draft";
    await seam.setState({ conversationId: "b" }, {});
    expect(seam.inputEl.value).toBe("");
    seam.inputEl.value = "B draft";
    await seam.setState({ conversationId: "a" }, {});
    expect(seam.inputEl.value).toBe("A draft");
    await seam.setState({ conversationId: null }, {});
    expect(seam.inputEl.value).toBe("");
    await seam.setState({ conversationId: "b" }, {});
    expect(seam.inputEl.value).toBe("B draft");
  });

  it("getState/setState round trip: a known id loads that conversation and is reflected back", async () => {
    const conversation: Conversation = { id: "b", title: "Release notes", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({}, conversationFakes({ conversations: [conversation] })));

    await seam.setState({ conversationId: "b" }, {});

    expect(seam.conversationId).toBe("b");
    expect(seam.getState()).toEqual({ conversationId: "b" });
  });

  it("setState with an unknown id keeps the current state", async () => {
    const known: Conversation = { id: "known", title: "T", createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({}, conversationFakes({ conversations: [known] })));
    seam.conversationId = "known";

    await seam.setState({ conversationId: "ghost-id" }, {});

    expect(seam.conversationId).toBe("known");
    expect(seam.getState()).toEqual({ conversationId: "known" });
  });

  it("clearChat nulls the conversation id without touching the store's active id", () => {
    const fakes = conversationFakes();
    const startNew = vi.spyOn(fakes.conversations, "startNew").mockResolvedValue(undefined);
    const seam = buildView(statePlugin({}, fakes));
    seam.conversationId = "existing";

    seam.clearChat();

    expect(seam.conversationId).toBeNull();
    expect(startNew).not.toHaveBeenCalled();
  });

  it("loadConversation calls the leaf's updateHeader when present, so the tab title follows the active conversation", () => {
    const conversation: Conversation = { id: "b", title: "Release notes", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] };
    const seam = buildView(statePlugin({}, conversationFakes({ conversations: [conversation] })));
    const updateHeader = vi.fn();
    (seam as unknown as { leaf: { updateHeader: () => void } }).leaf.updateHeader = updateHeader;

    (seam as unknown as { loadConversation(c: Conversation): void }).loadConversation(conversation);

    expect(updateHeader).toHaveBeenCalledOnce();
  });

  it("picking a project on an unstarted tab creates no conversation; the first turn persists the projectId", async () => {
    const project: ChatProject = { id: "Claude/Projects/Launch.md", name: "Launch", folder: null, pinned: [], instructions: "Ship it.", source: "note" };
    const stream = vi.fn(async (_request: unknown, handlers: { onDone(text: string): void }) => { handlers.onDone("answer"); });
    const provider = { id: "anthropic", hasCredentials: () => true, stream };
    const fakes = conversationFakes();
    const turns = fakes.stubTurns();
    const setProject = vi.spyOn(fakes.conversations, "setProject").mockResolvedValue(undefined);
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
      semantic: () => ({ semanticSearch: async () => [] }),
      loadedOntology: async () => null,
      turnService: () => new ChatTurnService(),
      chatProjectFor: async () => project,
    }, fakes);
    const seam = buildView(plugin) as unknown as Seam & {
      applyChosenProject(p: ChatProject): Promise<void>;
      run(userText: string): Promise<void>;
      projects: { pendingProjectId: string | null };
    };

    await seam.applyChosenProject(project);

    expect(setProject).not.toHaveBeenCalled();
    expect(seam.projects.pendingProjectId).toBe(project.id);
    expect(seam.conversationId).toBeNull();

    await seam.run("Hello");

    expect(turns.begin).toHaveBeenCalledOnce();
    expect(setProject).toHaveBeenCalledOnce();
    expect(setProject).toHaveBeenCalledWith("conversation-1", project.id);
    expect(seam.projects.pendingProjectId).toBeNull();
  });
});

describe("ChatView reused drafts", () => {
  const prompt = "Summarize the pilot.";
  const draft = "  Compare the pilot.\nKeep the limitations clear.  ";
  function fixture(text = draft, message: { content: string; display?: string } = { content: prompt }, stored = true) {
    const view = buildView(statePlugin()) as Seam & {
      renderStoredMessage(message: { role: "user"; content: string; display?: string }): void;
      transcript: { renderMessage(role: "user", text: string, opts: { command: boolean; prompt: string }): void };
    };
    const input = new FakeElement() as unknown as HTMLTextAreaElement;
    input.value = text;
    view.inputEl = input;
    view.composer.autosizeInput = vi.fn();
    const focus = vi.spyOn(input, "focus");
    if (stored) view.renderStoredMessage({ role: "user", ...message });
    else view.transcript.renderMessage("user", message.display ?? message.content, { command: message.display !== undefined, prompt: message.content });
    const previous = getLastOpenedModal();
    (view.messagesEl as unknown as FakeElement).querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Use again")!.dispatchEvent({ type: "click" });
    const modal = getLastOpenedModal();
    return { view, input, focus, modal: modal === previous ? undefined : modal };
  }

  it.each(["keep", "close", "replace"])("requires an explicit replacement decision: %s", async (choice) => {
    const { input, focus, modal } = fixture();
    expect(input.value).toBe(draft);
    expect(modal).toBeDefined();
    const buttons = (modal!.contentEl as unknown as FakeElement).querySelectorAll("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Keep draft", "Replace draft"]);
    if (choice === "close") modal!.close();
    else buttons[choice === "keep" ? 0 : 1]!.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(input.value).toBe(choice === "replace" ? prompt : draft);
    expect(focus).toHaveBeenCalled();
  });

  it.each(["", "  ", prompt])("reuses immediately without a dialog for %j", (text) => {
    const { input, modal } = fixture(text);
    expect(input.value).toBe(prompt);
    expect(modal).toBeUndefined();
  });

  it.each([false, true])("reuses the editable invocation for a recognized skill (stored: %s)", (stored) => {
    const display = "/wikilink-weaver Notes/Pilot.md";
    const { input, modal } = fixture("", { content: "Expanded model instructions", display }, stored);
    expect(input.value).toBe(display);
    expect(modal).toBeUndefined();
  });

  it.each([undefined, "Weekly review", "/not-installed Notes/Pilot.md"])("retains model text for an ordinary or unrecognized display: %s", (display) => {
    const { input } = fixture("", { content: prompt, display });
    expect(input.value).toBe(prompt);
  });

  it("does not replace a newer edit while the dialog is open", async () => {
    const { input, modal } = fixture();
    expect(modal).toBeDefined();
    input.value = "A newer draft";
    (modal!.contentEl as unknown as FakeElement).querySelectorAll("button")[1]!.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(input.value).toBe("A newer draft");
  });

  it("cancels when typing changes, even if the original text is restored", () => {
    const { input, modal } = fixture();
    expect(modal).toBeDefined();
    input.value = "A newer draft";
    input.dispatchEvent(new Event("input"));
    input.value = draft;
    expect(modal!.closed).toBe(true);
    expect(input.value).toBe(draft);
  });

  it("does not replace a draft after chat navigation", async () => {
    const { view, input, modal, focus } = fixture();
    expect(modal).toBeDefined();
    view.clearChat();
    input.value = draft;
    focus.mockClear();
    (modal!.contentEl as unknown as FakeElement).querySelectorAll("button")[1]!.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(input.value).toBe(draft);
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("ChatView refused submissions", () => {
  function fixture(credentials = false) {
    const fakes = conversationFakes();
    const provider = { id: "anthropic", hasCredentials: () => credentials };
    const plugin = statePlugin({ router: () => ({
      chatBackend: "custom", anthropic: provider,
      chatProvider: () => ({ provider, model: "m" }),
      chatCapabilities: () => ({ cli: false, local: false }),
    }) }, fakes);
    const view = buildView(plugin) as Seam & {
      onSend(): Promise<void>;
      submitPrompt(text: string): Promise<boolean>;
    };
    const input = new FakeElement() as unknown as HTMLTextAreaElement;
    view.inputEl = input;
    view.composer.autosizeInput = () => undefined;
    return { view, input, fakes };
  }

  it.each(["  Compare the pilot.\nKeep the assumptions separate.  ", "  /wikilink-weaver Notes/Alpha.md  "])("retains the exact typed draft when preflight refuses it: %s", async (draft) => {
    const { view, input, fakes } = fixture();
    input.value = draft;
    await view.onSend();
    expect(input.value).toBe(draft);
    expect(fakes.conversations.list()).toEqual([]);
  });

  it("retains the existing composer when a command prompt cannot start", async () => {
    const { view, input } = fixture();
    input.value = "My unfinished question";
    expect(await view.submitPrompt("A generated workflow prompt")).toBe(false);
    expect(input.value).toBe("My unfinished question");
  });

  it("does not replace newer typing when saving a request fails", async () => {
    const { view, input, fakes } = fixture(true);
    let started!: () => void;
    const saving = new Promise<void>((resolve) => { started = resolve; });
    let reject!: (reason: Error) => void;
    vi.spyOn(fakes.conversations, "beginTurn").mockImplementation(() => {
      started();
      return new Promise((_resolve, fail) => { reject = fail; });
    });
    input.value = "Original question";
    const pending = view.onSend();
    await saving;
    input.value = "Newer question";
    input.dispatchEvent(new Event("input"));
    reject(new Error("disk full"));
    await pending;
    expect(input.value).toBe("Newer question");
  });
});

describe("ChatView chat-scoped context toggles", () => {
  const OFF = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

  function viewWith(plugin: ClaudeCompanionPlugin): Seam {
    const seam = buildView(plugin);
    (seam as unknown as { updateUsageBar(): void }).updateUsageBar = () => undefined;
    (seam as unknown as { renderContextManager(): void }).renderContextManager = () => undefined;
    return seam;
  }

  it("two tabs do not share toggles", () => {
    const plugin = statePlugin();
    plugin.settings.context = { ...OFF };
    const a = viewWith(plugin);
    const b = viewWith(plugin);

    a.toggleAutomaticContext("searchVault", true);

    expect(a.contextToggles.searchVault).toBe(true);
    expect(b.contextToggles.searchVault).toBe(false);
    expect(plugin.settings.context.searchVault).toBe(false);
  });

  it("a new view starts from the current defaults", () => {
    const plugin = statePlugin();
    plugin.settings.context = { ...OFF, linkedNotes: true };
    expect(viewWith(plugin).contextToggles).toEqual({ ...OFF, linkedNotes: true });
  });

  it("clearChat re-reads current defaults", () => {
    const plugin = statePlugin();
    plugin.settings.context = { ...OFF };
    const seam = viewWith(plugin);
    seam.toggleAutomaticContext("searchVault", true);
    plugin.settings.context = { ...OFF, selection: true };

    seam.clearChat();

    expect(seam.contextToggles).toEqual({ ...OFF, selection: true });
  });

  it("loadConversation keeps the tab's toggles", () => {
    const conversation: Conversation = { id: "b", title: "T", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] };
    const plugin = statePlugin({}, conversationFakes({ conversations: [conversation] }));
    plugin.settings.context = { ...OFF };
    const seam = viewWith(plugin);
    seam.toggleAutomaticContext("searchVault", true);

    seam.loadConversation(conversation);

    expect(seam.contextToggles.searchVault).toBe(true);
  });

  it("workspace question attaches when the tab's active note is off", () => {
    const plugin = statePlugin();
    plugin.settings.context = { ...OFF, activeNote: true };
    const seam = viewWith(plugin);
    seam.attachedPaths = [];
    seam.inputEl = { value: "", focus: () => undefined };
    seam.composer.autosizeInput = () => undefined;
    seam.resolveMarkdownContextView = () => ({ file: { path: "Notes/Alpha.md" } });
    seam.toggleAutomaticContext("activeNote", false);

    seam.prepareWorkspaceQuestion({ kind: "note", title: "Continue with Alpha", contextPath: "Notes/Alpha.md" });

    expect(seam.attachedPaths).toEqual([{ path: "Notes/Alpha.md", kind: "note" }]);
  });
});

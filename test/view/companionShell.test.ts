import { App, FakeElement, getLastOpenedModal, Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { OBSIDIAN_GENERAL_SETTINGS_TAB } from "../../src/integrations/desktop";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { CompanionShell } from "../../src/view/companionShell";
import { SYSTEM_VIEW_TYPE } from "../../src/view/SystemView";
import { chatView, systemView } from "../fakes/view";

interface Rig {
  app: App;
  shell: CompanionShell;
  settings: PluginSettings;
  activity: ActivityStore;
  saveSettings: ReturnType<typeof vi.fn>;
  semantic: Record<string, ReturnType<typeof vi.fn>>;
  memory: { consolidateMemory: ReturnType<typeof vi.fn> };
  clipper: { status: ReturnType<typeof vi.fn>; openSetup: ReturnType<typeof vi.fn> };
  desktop: { open: ReturnType<typeof vi.fn> };
  orders: { retry: ReturnType<typeof vi.fn> };
  conversations: Record<string, ReturnType<typeof vi.fn>>;
  views: { activateInboxView: ReturnType<typeof vi.fn>; activateView: ReturnType<typeof vi.fn> };
  chatLeafFor: ReturnType<typeof vi.fn>;
  workspace: Record<string, unknown>;
}

function rig(indexedNotes = 0): Rig {
  const app = new App();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const activity = new ActivityStore();
  const saveSettings = vi.fn(async () => undefined);
  const semantic = {
    indexer: vi.fn(() => ({ stats: async () => ({ notes: indexedNotes }) })),
    indexerHealth: vi.fn(() => ({ embeddingHealth: "ok", indexHealth: "built" })),
    rebuildSemanticIndex: vi.fn(async () => undefined),
    downloadBuiltinModelAndIndex: vi.fn(async () => undefined),
    canEmbedWithoutDownload: vi.fn(async () => true),
  };
  const memory = { consolidateMemory: vi.fn(async () => undefined) };
  const clipper = { status: vi.fn(() => "current"), openSetup: vi.fn() };
  const desktop = { open: vi.fn() };
  const orders = { retry: vi.fn(async () => undefined) };
  const conversations = {
    list: vi.fn(() => [] as unknown[]),
    stopTurn: vi.fn(async () => undefined),
    setActive: vi.fn(async () => undefined),
    getActive: vi.fn(() => undefined as unknown),
  };
  const views = { activateInboxView: vi.fn(async () => undefined), activateView: vi.fn(async () => null as unknown) };
  const chatLeafFor = vi.fn(() => null as unknown);
  const workspace = { getLeavesOfType: vi.fn(() => [] as unknown[]), revealLeaf: vi.fn(async () => undefined), getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => undefined) })) };
  Object.assign(app.workspace, workspace);
  const shell = new CompanionShell({
    app,
    settings: () => settings,
    saveSettings,
    activity: () => activity,
    router: () => ({ chatBackend: "claude", researchStatus: () => ({ model: "off", providerLabel: "Claude", modelId: "m", available: true }) }) as never,
    semantic: () => semantic as never,
    memory: () => memory as never,
    clipperSetup: () => clipper as never,
    desktopIntegrations: () => desktop as never,
    standingOrders: () => orders as never,
    conversations: () => conversations as never,
    views: () => views as never,
    chatLeafFor,
  });
  return { app, shell, settings, activity, saveSettings, semantic, memory, clipper, desktop, orders, conversations, views, chatLeafFor, workspace };
}

beforeEach(() => { Platform.isMobile = false; });
afterEach(() => { Platform.isMobile = false; vi.unstubAllGlobals(); });

describe("CompanionShell chrome", () => {
  it("builds chrome dependencies over the live app and activity store", () => {
    const r = rig();
    const chrome = r.shell.companionChrome();
    expect(chrome.app).toBe(r.app);
    expect(chrome.activity).toBe(r.activity);
    const id = r.activity.start({ kind: "vault-task", title: "Task" });
    chrome.dismissActivity(id);
    expect(r.activity.snapshot().records.find((record) => record.id === id)?.state).not.toBe("running");
    chrome.openDesktopIntegrations();
    expect(r.desktop.open).toHaveBeenCalledTimes(1);
  });

  it("summarizes the current options, naming the embedding model and a sanitized utility endpoint", () => {
    const r = rig();
    r.settings.embeddingEngine = "ollama";
    r.settings.embeddingModel = "nomic-embed";
    r.settings.utilityBackend = "ollama";
    r.settings.ollamaHost = "http://user:secret@127.0.0.1:11434";
    r.settings.researchModel = "off";
    const snapshot = r.shell.companionChrome().snapshot();
    expect(snapshot).toMatchObject({
      isMobile: false,
      chatBackend: "claude",
      embeddingModel: "nomic-embed",
      embeddingHealth: "ok",
      indexHealth: "built",
      researchModelLabel: "AI off",
      clipperStatus: "current",
    });
    expect(snapshot.utilityEndpoint).toEqual(expect.any(String));
    expect(JSON.stringify(snapshot)).not.toContain("secret");

    r.settings.embeddingEngine = "custom";
    r.settings.openaiCompatEmbeddingModel = "text-embedding-x";
    r.settings.utilityBackend = "claude";
    const next = r.shell.companionChrome().snapshot();
    expect(next.embeddingModel).toBe("text-embedding-x");
    expect("utilityEndpoint" in next).toBe(false);

    r.settings.embeddingEngine = "builtin";
    expect(r.shell.companionChrome().snapshot().embeddingModel).toEqual(expect.any(String));
  });
});

describe("CompanionShell quick option saves", () => {
  it.each([
    ["agent-mode", true, (s: PluginSettings) => s.agentModeEnabled, true],
    ["vault-context", true, (s: PluginSettings) => s.context.searchVault, true],
    ["memory-capture", false, (s: PluginSettings) => s.memoryIngestOnSave, false],
    ["utility-backend", "ollama", (s: PluginSettings) => s.utilityBackend, "ollama"],
    ["source-capture", true, (s: PluginSettings) => s.sourceCaptureEnabled, true],
    ["semantic-search", true, (s: PluginSettings) => s.semanticEnabled, true],
    ["embedding-engine", "custom", (s: PluginSettings) => s.embeddingEngine, "custom"],
    ["memory-enabled", true, (s: PluginSettings) => s.memoryEnabled, true],
    ["discovery-enabled", true, (s: PluginSettings) => s.discoveryEnabled, true],
    ["research-model", "claude", (s: PluginSettings) => s.researchModel, "claude"],
    ["chat-backend", "claude", (s: PluginSettings) => s.chatBackend, "claude"],
  ] as const)("%s persists through saveSettings", async (id, value, read, expected) => {
    const r = rig();
    await r.shell.companionChrome().save({ id, value });
    expect(read(r.settings)).toBe(expected);
    expect(r.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("trims folder values and falls back to their defaults when blank", async () => {
    const r = rig();
    const { save } = r.shell.companionChrome();
    await save({ id: "inbox-folder", value: "  Inbox  " });
    expect(r.settings.sourceInboxFolder).toBe("Inbox");
    await save({ id: "inbox-folder", value: "  " });
    expect(r.settings.sourceInboxFolder).toBe("Clippings");
    await save({ id: "memory-folder", value: " Mem " });
    expect(r.settings.memoryFolder).toBe("Mem");
    await save({ id: "memory-folder", value: "" });
    expect(r.settings.memoryFolder).toBe("Claude/Memory");
  });

  it("records source-capture consent only when auto-enrich turns on", async () => {
    const r = rig();
    r.settings.sourceCaptureConsent = "ask" as never;
    await r.shell.companionChrome().save({ id: "auto-enrich", value: false });
    expect(r.settings.sourceEnrichOnCreate).toBe(false);
    expect(r.settings.sourceCaptureConsent).toBe("ask");
    await r.shell.companionChrome().save({ id: "auto-enrich", value: true });
    expect(r.settings.sourceEnrichOnCreate).toBe(true);
    expect(r.settings.sourceCaptureConsent).toBe("allow");
  });

  it.each([
    ["chat-backend", "not-a-backend", "Choose a valid chat backend."],
    ["utility-backend", "nope", "Choose a valid utility backend."],
    ["embedding-engine", "nope", "Choose a valid embedding engine."],
    ["research-model", "nope", "Choose a valid research model."],
    ["unknown-option", true, "That quick setting is not available."],
  ] as const)("rejects an invalid %s value without saving", async (id, value, message) => {
    const r = rig();
    await expect(r.shell.companionChrome().save({ id, value })).rejects.toThrow(message);
    expect(r.saveSettings).not.toHaveBeenCalled();
  });
});

describe("CompanionShell embedding engine switch", () => {
  const button = (label: string) =>
    (getLastOpenedModal()?.contentEl as unknown as FakeElement).querySelectorAll("button").find(({ textContent }) => textContent === label);

  it("offers a rebuild when the index held notes, and rebuilds on choice", async () => {
    const r = rig(3);
    await r.shell.companionChrome().save({ id: "embedding-engine", value: "ollama" });
    expect(r.settings.embeddingEngine).toBe("ollama");
    expect(r.saveSettings).toHaveBeenCalledTimes(1);
    const modal = getLastOpenedModal();
    expect(modal?.titleEl.textContent).toBe("Rebuild the semantic index?");
    expect((modal?.contentEl as unknown as FakeElement).querySelectorAll("p")[0]?.textContent).toContain("ollama");
    expect(r.semantic.rebuildSemanticIndex).not.toHaveBeenCalled();
    button("Rebuild now")?.dispatchEvent({ type: "click" });
    expect(r.semantic.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild when the offer is declined", async () => {
    const r = rig(3);
    await r.shell.companionChrome().save({ id: "embedding-engine", value: "custom" });
    button("Later")?.dispatchEvent({ type: "click" });
    expect(r.semantic.rebuildSemanticIndex).not.toHaveBeenCalled();
  });

  it("saves without an offer when the index is empty", async () => {
    const r = rig(0);
    const before = getLastOpenedModal();
    await r.shell.companionChrome().save({ id: "embedding-engine", value: "ollama" });
    expect(r.saveSettings).toHaveBeenCalledTimes(1);
    expect(getLastOpenedModal()).toBe(before);
  });

  it("neither saves nor offers when the engine is unchanged", async () => {
    const r = rig(3);
    const before = getLastOpenedModal();
    await r.shell.companionChrome().save({ id: "embedding-engine", value: r.settings.embeddingEngine });
    expect(r.saveSettings).not.toHaveBeenCalled();
    expect(getLastOpenedModal()).toBe(before);
  });
});

describe("CompanionShell quick actions", () => {
  const page = "chat" as const;

  it("routes semantic index actions", async () => {
    const r = rig();
    const { run } = r.shell.companionChrome();
    await run({ id: "rebuild-index", page });
    await run({ id: "retry-index", page });
    await run({ id: "download-builtin", page });
    expect(r.semantic.rebuildSemanticIndex).toHaveBeenCalledTimes(2);
    expect(r.semantic.downloadBuiltinModelAndIndex).toHaveBeenCalledTimes(1);
  });

  it("switches to built-in embeddings, downloading the model only when it is not ready", async () => {
    const r = rig();
    await r.shell.companionChrome().run({ id: "use-builtin-embeddings", page });
    expect(r.settings.embeddingEngine).toBe("builtin");
    expect(r.saveSettings).toHaveBeenCalledTimes(1);
    expect(r.semantic.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
    expect(r.semantic.downloadBuiltinModelAndIndex).not.toHaveBeenCalled();

    r.semantic.canEmbedWithoutDownload!.mockResolvedValue(false);
    await r.shell.companionChrome().run({ id: "use-builtin-embeddings", page });
    expect(r.semantic.downloadBuiltinModelAndIndex).toHaveBeenCalledTimes(1);
    expect(r.semantic.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
  });

  it("routes memory, clipper and inbox actions", async () => {
    const r = rig();
    const { run } = r.shell.companionChrome();
    await run({ id: "consolidate-memory", page });
    await run({ id: "clipper-schemas", page });
    await run({ id: "clippings-inbox", page });
    await run({ id: "review-inbox-failures", page });
    expect(r.memory.consolidateMemory).toHaveBeenCalledTimes(1);
    expect(r.clipper.openSetup).toHaveBeenCalledTimes(1);
    expect(r.views.activateInboxView).toHaveBeenCalledTimes(2);
  });

  it("re-renders open System views", async () => {
    const r = rig();
    const system = systemView();
    const render = vi.spyOn(system, "render").mockResolvedValue(undefined);
    (r.workspace.getLeavesOfType as ReturnType<typeof vi.fn>).mockImplementation((type: string) => (type === SYSTEM_VIEW_TYPE ? [{ view: system }, { view: {} }] : []));
    await r.shell.companionChrome().run({ id: "refresh-system", page });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it.each(["embedding-health", "embedding-settings", "utility-settings", "all-settings"])("%s opens the Companion settings tab", async (id) => {
    const r = rig();
    const open = vi.fn();
    const openTabById = vi.fn();
    (r.app as unknown as { setting: unknown }).setting = { open, openTabById };
    await r.shell.companionChrome().run({ id, page });
    expect(open).toHaveBeenCalledTimes(1);
    expect(openTabById).toHaveBeenCalledWith("claude-companion");
  });

  it("rejects an action it does not know", async () => {
    const r = rig();
    await expect(r.shell.companionChrome().run({ id: "mystery", page })).rejects.toThrow("That quick action is not available yet.");
  });
});

describe("CompanionShell settings openers", () => {
  it("opens Obsidian's General tab for the CLI switch", () => {
    const r = rig();
    const open = vi.fn();
    const openTabById = vi.fn();
    (r.app as unknown as { setting: unknown }).setting = { open, openTabById };
    r.shell.openObsidianCliSettings();
    expect(openTabById).toHaveBeenCalledWith(OBSIDIAN_GENERAL_SETTINGS_TAB);
  });

  it("opens the settings dialog even when it cannot select a tab", () => {
    const r = rig();
    const open = vi.fn();
    (r.app as unknown as { setting: unknown }).setting = { open };
    expect(() => r.shell.openCompanionSettings()).not.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("falls back to the open-settings command when the settings API is absent", () => {
    const r = rig();
    const executeCommandById = vi.fn(() => true);
    (r.app as unknown as { commands: unknown }).commands = { executeCommandById };
    r.shell.openCompanionSettings();
    expect(executeCommandById).toHaveBeenCalledWith("app:open-settings");
  });

  it("does nothing when neither API exists", () => {
    const r = rig();
    expect(() => r.shell.openCompanionSettings()).not.toThrow();
  });
});

describe("CompanionShell activity recovery", () => {
  it("retries a failed order run through the standing-orders controller", async () => {
    const r = rig();
    await r.shell.runActivityRecovery("order:Orders/A.md:3", "retry");
    expect(r.orders.retry).toHaveBeenCalledWith("order:Orders/A.md:3");
  });

  it("opens the order note for any other order action and fails when the note is gone", async () => {
    const r = rig();
    const note = r.app.vault.seed("Orders/A.md", "order");
    const openFile = vi.fn(async () => undefined);
    (r.workspace.getLeaf as ReturnType<typeof vi.fn>).mockReturnValue({ openFile });
    await r.shell.runActivityRecovery("order:Orders/A.md:3", "open");
    expect(openFile).toHaveBeenCalledWith(note);
    await expect(r.shell.runActivityRecovery("order:Orders/Missing.md:1", "open")).rejects.toThrow("Order note missing: Orders/Missing.md");
  });

  it("rejects recovery for a conversation that no longer exists", async () => {
    const r = rig();
    await expect(r.shell.runActivityRecovery("chat-turn:gone", "resume-chat-turn")).rejects.toThrow("That conversation no longer exists.");
  });

  it("stops the active turn of the exact conversation, or does nothing when none is running", async () => {
    const r = rig();
    r.conversations.list!.mockReturnValue([{ id: "c1", activeTurn: { id: "t1" } }, { id: "c2" }]);
    await r.shell.runActivityRecovery("chat-turn:c1", "stop-chat-turn");
    expect(r.conversations.stopTurn).toHaveBeenCalledWith("c1", "t1");
    await r.shell.runActivityRecovery("chat-turn:c2", "stop-chat-turn");
    expect(r.conversations.stopTurn).toHaveBeenCalledTimes(1);
    expect(r.conversations.setActive).not.toHaveBeenCalled();
  });

  it("reveals an open chat leaf, loads the conversation and resumes the interrupted turn", async () => {
    const r = rig();
    const conversation = { id: "c1", activeTurn: { id: "t1" } };
    const active = { id: "c1", activeTurn: { id: "t1", state: "interrupted" } };
    r.conversations.list!.mockReturnValue([conversation]);
    r.conversations.getActive!.mockReturnValue(active);
    const view = chatView(undefined, {
      loadConversation: vi.fn(),
      resumeInterruptedTurn: vi.fn(async () => undefined),
    });
    const existing = { view };
    r.chatLeafFor.mockReturnValue(existing);
    await r.shell.runActivityRecovery("chat-turn:c1", "resume-chat-turn");
    expect(r.conversations.setActive).toHaveBeenCalledWith("c1");
    expect(r.workspace.revealLeaf).toHaveBeenCalledWith(existing);
    expect(view.loadConversation).toHaveBeenCalledWith(active);
    expect(view.resumeInterruptedTurn).toHaveBeenCalledWith(active);
    expect(r.views.activateView).not.toHaveBeenCalled();
  });

  it("opens a chat view when none shows the conversation and does not resume on a plain open", async () => {
    const r = rig();
    const conversation = { id: "c1" };
    r.conversations.list!.mockReturnValue([conversation]);
    const view = { loadConversation: vi.fn(), resumeInterruptedTurn: vi.fn() };
    r.views.activateView.mockResolvedValue(view);
    await r.shell.runActivityRecovery("chat-turn:c1", "open-chat");
    expect(view.loadConversation).toHaveBeenCalledWith(conversation);
    expect(view.resumeInterruptedTurn).not.toHaveBeenCalled();
  });

  it("skips loading when no chat view could be opened", async () => {
    const r = rig();
    r.conversations.list!.mockReturnValue([{ id: "c1" }]);
    r.views.activateView.mockResolvedValue(null);
    await expect(r.shell.runActivityRecovery("chat-turn:c1", "resume-chat-turn")).resolves.toBeUndefined();
  });

  it("copies the tail of the enrichment diagnostics log", async () => {
    const r = rig();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    (r.app.vault as unknown as { adapter: unknown }).adapter = { exists: async () => true, read: async () => `${"a".repeat(9000)}END` };
    await r.shell.runActivityRecovery("semantic-index", "copy-diagnostics");
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toHaveLength(8192);
    expect(copied.endsWith("END")).toBe(true);
  });

  it("explains a missing diagnostics log and a missing clipboard", async () => {
    const r = rig();
    const vault = r.app.vault as unknown as { adapter: unknown };
    vault.adapter = { exists: async () => false, read: async () => "" };
    await expect(r.shell.runActivityRecovery("x", "copy-diagnostics")).rejects.toThrow("No enrichment diagnostics log exists yet");
    vault.adapter = { exists: async () => true, read: async () => "log" };
    vi.stubGlobal("navigator", {});
    await expect(r.shell.runActivityRecovery("x", "copy-diagnostics")).rejects.toThrow("Clipboard access is unavailable on this device.");
  });

  it("copies the technical details of an activity record", async () => {
    const r = rig();
    const id = r.activity.start({ kind: "vault-task", title: "Task" });
    r.activity.fail(id, { technicalDetails: "stack trace", details: [] });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await r.shell.runActivityRecovery(id, "copy-details");
    expect(writeText).toHaveBeenCalledWith("stack trace");
    await expect(r.shell.runActivityRecovery("missing", "copy-details")).rejects.toThrow("No technical details are available for this activity.");
    vi.stubGlobal("navigator", {});
    await expect(r.shell.runActivityRecovery(id, "copy-details")).rejects.toThrow("Clipboard access is unavailable on this device.");
  });

  it("hands any other recovery action to the quick-action router", async () => {
    const r = rig();
    await r.shell.runActivityRecovery("semantic-related:1", "retry-index");
    expect(r.semantic.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
    await expect(r.shell.runActivityRecovery("a", "mystery")).rejects.toThrow("That quick action is not available yet.");
  });
});

import { App, clearNotices, FakeElement, getLastOpenedModal, getNoticeMessages, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";
import { conversationFakes } from "../fakes/conversations";

const memoryFake = { captureConversation: vi.fn(async () => undefined) };

function plugin(overrides: Record<string, unknown> = {}, fakes = conversationFakes()): ClaudeCompanionPlugin {
  memoryFake.captureConversation.mockClear();
  const app = new App();
  (app.workspace as unknown as { getActiveViewOfType(): null; getActiveFile(): null }).getActiveViewOfType = () => null;
  (app.workspace as unknown as { getActiveFile(): null }).getActiveFile = () => null;
  const chromeDeps = { app, activity: new ActivityStore(), snapshot: () => ({}), save: vi.fn(), run: vi.fn(), openAllSettings: vi.fn(), openDesktopIntegrations: vi.fn() } as unknown as CompanionChromeDependencies;
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
    commandActions: () => ({}),
    ...fakes.host,
    secrets: () => ({ available: () => false }),
    composeSystemPrompt: () => "system",
    views: () => ({ companionWorkspaceContext: async () => null }),
    memory: () => memoryFake,
    ...overrides,
  } as unknown as ClaudeCompanionPlugin;
}

async function openView(p: ClaudeCompanionPlugin, conversationId: string | null = "c1"): Promise<ChatView> {
  const view = new ChatView(new WorkspaceLeaf(p.app as unknown as App), p);
  (view as unknown as { containerEl: { style: { setProperty(): void } } }).containerEl = { style: { setProperty: () => undefined } };
  await view.onOpen();
  const internals = view as unknown as { conversationId: string | null; messages: Array<{ role: string; content: string }> };
  internals.conversationId = conversationId;
  internals.messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
  return view;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("distill replaces save-to-vault", () => {
  it("the header menu's Distill this chat distills the view's conversation and writes no raw dump", async () => {
    const fakes = conversationFakes();
    const p = plugin({}, fakes);
    const create = vi.spyOn(p.app.vault, "create");
    const view = await openView(p);
    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();
    const content = getLastOpenedModal()!.contentEl as unknown as FakeElement;
    const button = content.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Distill this chat")!;
    button.dispatchEvent({ type: "click" });
    await flush();
    expect(fakes.distill).toHaveBeenCalledWith("c1");
    expect(create).not.toHaveBeenCalled();
  });

  it("/save distills the same way", async () => {
    const fakes = conversationFakes();
    const p = plugin({}, fakes);
    const view = await openView(p);
    await (view as unknown as { slash: { run(c: unknown): Promise<void> } }).slash.run({ name: "save", description: "", kind: "action", action: "save" });
    expect(fakes.distill).toHaveBeenCalledWith("c1");
  });

  it("a plugin-level slash command clears the composer before running the command action and starts no turn", async () => {
    const fakes = conversationFakes();
    const turns = fakes.stubTurns();
    let composerAtCall: string | undefined;
    const composer: { input?: { value: string } } = {};
    const generatePlanFromNote = vi.fn(async () => { composerAtCall = composer.input?.value; });
    const p = plugin({ commandActions: () => ({ generatePlanFromNote }) }, fakes);
    const view = await openView(p);
    const input = (view as unknown as { inputEl: { value: string } }).inputEl;
    composer.input = input;
    input.value = "/plan";
    await (view as unknown as { slash: { run(c: unknown): Promise<void> } }).slash.run({ name: "plan", description: "", kind: "action", action: "generatePlanFromNote" });
    expect(generatePlanFromNote).toHaveBeenCalledOnce();
    expect(composerAtCall).toBe("");
    expect(input.value).toBe("");
    expect(turns.begin).not.toHaveBeenCalled();
  });

  it("an unknown action id notices and runs nothing", async () => {
    clearNotices();
    const generatePlanFromNote = vi.fn();
    const p = plugin({ commandActions: () => ({ generatePlanFromNote }) });
    const view = await openView(p);
    await (view as unknown as { slash: { run(c: unknown): Promise<void> } }).slash.run({ name: "bogus", description: "", kind: "action", action: "bogus" });
    expect(generatePlanFromNote).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toContain("Unknown command: /bogus");
  });

  it("files into session memory after a successful distill when ingest-on-save is on", async () => {
    const p = plugin();
    p.settings.memoryEnabled = true;
    p.settings.memoryIngestOnSave = true;
    const view = await openView(p);
    await view.distillThisChat();
    expect(memoryFake.captureConversation).toHaveBeenCalledOnce();
  });

  it("skips memory capture when the distill wrote nothing", async () => {
    const fakes = conversationFakes();
    fakes.distill.mockResolvedValue(null);
    const p = plugin({}, fakes);
    p.settings.memoryEnabled = true;
    p.settings.memoryIngestOnSave = true;
    const view = await openView(p);
    await view.distillThisChat();
    expect(memoryFake.captureConversation).not.toHaveBeenCalled();
  });

  it("a chat with no stored conversation notices and makes no call", async () => {
    clearNotices();
    const fakes = conversationFakes();
    const p = plugin({}, fakes);
    const view = await openView(p, null);
    await view.distillThisChat();
    expect(fakes.distill).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toContain("Nothing to distill yet.");
  });
});

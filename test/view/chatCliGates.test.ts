import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, getLastOpenedModal, getNoticeMessages, WorkspaceLeaf } from "../fakes/obsidian";
import { ChatView } from "../../src/view/ChatView";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import type ClaudeCompanionPlugin from "../../src/main";
import type { ChatCapabilities } from "../../src/providers/router";
import { defaultChatControls } from "../../src/claude/chatControls";

const CLI: ChatCapabilities = { agentActions: true, claudeControls: false, metered: false, local: false, cli: true };
const API: ChatCapabilities = { agentActions: true, claudeControls: true, metered: true, local: false, cli: false };

function pluginStub(settings: Partial<PluginSettings>, caps: ChatCapabilities, cliSignedIn: boolean): ClaudeCompanionPlugin & { cliTurnRunner: ReturnType<typeof vi.fn>; saveSettings: ReturnType<typeof vi.fn> } {
  const runner = { run: vi.fn(async () => ({ text: "", trace: [] })) };
  return {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...settings },
    router: () => ({
      chatProvider: () => ({ provider: { id: caps.cli ? "claude-cli" : "anthropic", hasCredentials: () => true }, model: DEFAULT_SETTINGS.model }),
      chatCapabilities: () => caps,
      chatToolCapable: async () => true,
      chatReasoningActive: async () => false,
      chatBackend: settings.chatBackend ?? "claude",
      claudeCli: { hasCredentials: () => cliSignedIn, available: () => true },
      anthropic: { hasCredentials: () => !cliSignedIn },
    }),
    cliTurnRunner: vi.fn(async () => runner),
    activeConversationId: () => "c1",
    interruptCliTurn: vi.fn(),
    secrets: () => ({ available: () => false }),
    saveSettings: vi.fn(async () => undefined),
    runFirstRunPrompts: vi.fn(async () => undefined),
    composeSystemPrompt: () => "sys",
    agentTools: () => ({ definitions: () => [] }),
    externalMcpTools: async () => [],
  } as unknown as ClaudeCompanionPlugin & { cliTurnRunner: ReturnType<typeof vi.fn>; saveSettings: ReturnType<typeof vi.fn> };
}

/** Render the composer controls row (model switcher, mode control, tune button) via the real renderControls(). */
function renderedControls(settings: Partial<PluginSettings>) {
  const plugin = pluginStub(settings, API, false);
  const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
  const seam = view as unknown as { controls: unknown; controlsEl: HTMLElement; renderControls(): void };
  seam.controls = defaultChatControls(DEFAULT_SETTINGS.model);
  seam.controlsEl = new FakeElement() as unknown as HTMLElement;
  seam.renderControls();
  return { view, plugin, controlsEl: seam.controlsEl as unknown as FakeElement };
}

describe("ChatView on the claude-cli backend", () => {
  it("picks the Claude Code runner for a turn and hands it the modal callbacks", async () => {
    const plugin = pluginStub({ chatBackend: "claude-cli" }, CLI, true);
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const request = { system: "sys", messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-5", maxTokens: 10, tools: [] };
    const picked = await (view as unknown as { turnRunnerFor(deps: unknown, request: unknown): Promise<unknown> }).turnRunnerFor({}, request);
    expect(plugin.cliTurnRunner).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1", planMode: false, agentMode: false, model: "claude-sonnet-5", transcript: "" }));
    const call = plugin.cliTurnRunner.mock.calls[0]![0] as { deps: { confirmWrite: unknown; proposeEdit: unknown } };
    expect(typeof call.deps.confirmWrite).toBe("function");
    expect(typeof call.deps.proposeEdit).toBe("function");
    expect(picked).toBe(await plugin.cliTurnRunner.mock.results[0]!.value);
  });

  it("uses the provider loop when capabilities are not cli", async () => {
    const plugin = pluginStub({}, API, false);
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const request = { system: "sys", messages: [{ role: "user", content: "hi" }], model: "m", maxTokens: 10 };
    const deps = { stream: vi.fn(), execute: vi.fn(), maxIterations: 1 };
    const picked = await (view as unknown as { turnRunnerFor(deps: unknown, request: unknown): Promise<{ run: unknown }> }).turnRunnerFor(deps, request);
    expect(plugin.cliTurnRunner).not.toHaveBeenCalled();
    expect(typeof picked.run).toBe("function");
  });

  it("offers vault actions in the overflow menu on the CLI backend", () => {
    const view = new ChatView(new WorkspaceLeaf(new App()), pluginStub({ chatBackend: "claude-cli" }, CLI, true));
    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();
    const content = getLastOpenedModal()?.contentEl as unknown as FakeElement;
    const buttons = content.querySelectorAll("button");
    expect(buttons.some((b) => b.getAttribute("aria-label") === "Act on vault" || (b.textContent ?? "").includes("Act on vault"))).toBe(true);
  });

  it("offers Research Desk in the mobile overflow and activates it", () => {
    const plugin = pluginStub({ chatBackend: "claude-cli" }, CLI, true);
    plugin.activateResearchDesk = vi.fn();
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);

    (view as unknown as { openOverflowMenu(): void }).openOverflowMenu();
    const item = (getLastOpenedModal()!.contentEl as unknown as FakeElement)
      .querySelectorAll("button")
      .find((button) => button.getAttribute("aria-label") === "Research Desk");
    item?.dispatchEvent({ type: "click" });

    expect(item).toBeDefined();
    expect(plugin.activateResearchDesk).toHaveBeenCalledTimes(1);
  });

  it("offers Claude Code sign-in on the setup card when the CLI is signed in and no key exists", () => {
    const view = new ChatView(new WorkspaceLeaf(new App()), pluginStub({ chatBackend: "claude", apiKey: "" }, API, true));
    const host = new FakeElement() as unknown as HTMLElement;
    (view as unknown as { renderSetupCard(parent: HTMLElement): void }).renderSetupCard(host);
    const buttons = (host as unknown as FakeElement).querySelectorAll("button");
    expect(buttons.some((b) => b.textContent === "Use Claude Code sign-in")).toBe(true);
  });

  it("leads the setup card with Claude Code when the CLI is signed in", () => {
    const view = new ChatView(new WorkspaceLeaf(new App()), pluginStub({ chatBackend: "claude", apiKey: "" }, API, true));
    const host = new FakeElement() as unknown as HTMLElement;
    (view as unknown as { renderSetupCard(parent: HTMLElement): void }).renderSetupCard(host);
    const sub = (host as unknown as FakeElement).querySelector(".cc-setup-sub");
    expect(sub?.textContent).toMatch(/^Claude Code is signed in on this computer/);
  });
});

describe("ChatView composer control order", () => {
  it("places the reasoning indicator between the model select and the mode control", () => {
    const { controlsEl } = renderedControls({});
    const modelIdx = controlsEl.children.findIndex((c) => c.classList.has("cc-ctl-model"));
    const reasoningIdx = controlsEl.children.findIndex((c) => c.classList.has("cc-reasoning-indicator"));
    const modeIdx = controlsEl.children.findIndex((c) => c.classList.has("cc-mode-control"));
    expect(modelIdx).toBe(0);
    expect(reasoningIdx).toBeGreaterThan(modelIdx);
    expect(modeIdx).toBeGreaterThan(reasoningIdx);
  });
});

describe("ChatView composer mode control", () => {
  it("renders one Ask / Plan / Act control with three radios", () => {
    const { controlsEl } = renderedControls({ agentAllowWrites: false });
    const control = controlsEl.querySelector(".cc-mode-control");
    expect(control).not.toBeNull();
    const radios = control!.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);
  });

  it("Act sets agentAllowWrites and saves; Plan leaves it and flips plan state; Ask clears both", () => {
    const { view, plugin, controlsEl } = renderedControls({ agentAllowWrites: false });
    const radios = controlsEl.querySelector(".cc-mode-control")!.querySelectorAll('[role="radio"]');
    const [ask, plan, act] = radios;
    const currentMode = () => (view as unknown as { currentMode(): string }).currentMode();

    act!.dispatchEvent({ type: "click" });
    expect(plugin.settings.agentAllowWrites).toBe(true);
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(currentMode()).toBe("act");
    expect(act!.getAttribute("aria-checked")).toBe("true");

    plan!.dispatchEvent({ type: "click" });
    expect(plugin.settings.agentAllowWrites).toBe(true); // untouched by Plan
    expect(currentMode()).toBe("plan");
    expect(plan!.getAttribute("aria-checked")).toBe("true");

    ask!.dispatchEvent({ type: "click" });
    expect(plugin.settings.agentAllowWrites).toBe(false);
    expect(currentMode()).toBe("ask");
    expect(ask!.getAttribute("aria-checked")).toBe("true");
  });

  it("restores the previous mode and setting when saveSettings rejects", async () => {
    const { view, plugin, controlsEl } = renderedControls({ agentAllowWrites: false });
    (plugin.saveSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const currentMode = () => (view as unknown as { currentMode(): string }).currentMode();

    await (view as unknown as { applyMode(mode: string): Promise<void> }).applyMode("act");

    expect(plugin.settings.agentAllowWrites).toBe(false);
    expect(currentMode()).toBe("ask");
    const radios = controlsEl.querySelector(".cc-mode-control")!.querySelectorAll('[role="radio"]');
    expect(radios.find((b) => b.getAttribute("aria-label")?.startsWith("Ask"))?.getAttribute("aria-checked")).toBe("true");
    expect(getNoticeMessages().some((m) => m.includes("Couldn't save the mode"))).toBe(true);
  });
});

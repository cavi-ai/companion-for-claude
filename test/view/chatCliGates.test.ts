import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, getLastOpenedModal, WorkspaceLeaf } from "../fakes/obsidian";
import { ChatView } from "../../src/view/ChatView";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import type ClaudeCompanionPlugin from "../../src/main";
import type { ChatCapabilities } from "../../src/providers/router";

const CLI: ChatCapabilities = { agentActions: true, claudeControls: false, metered: false, local: false, cli: true };
const API: ChatCapabilities = { agentActions: true, claudeControls: true, metered: true, local: false, cli: false };

function pluginStub(settings: Partial<PluginSettings>, caps: ChatCapabilities, cliSignedIn: boolean): ClaudeCompanionPlugin & { cliTurnRunner: ReturnType<typeof vi.fn> } {
  const runner = { run: vi.fn(async () => ({ text: "", trace: [] })) };
  return {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...settings },
    router: () => ({
      chatProvider: () => ({ provider: { id: caps.cli ? "claude-cli" : "anthropic", hasCredentials: () => true }, model: DEFAULT_SETTINGS.model }),
      chatCapabilities: () => caps,
      chatToolCapable: async () => true,
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
  } as unknown as ClaudeCompanionPlugin & { cliTurnRunner: ReturnType<typeof vi.fn> };
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

  it("offers Claude Code sign-in on the setup card when the CLI is signed in and no key exists", () => {
    const view = new ChatView(new WorkspaceLeaf(new App()), pluginStub({ chatBackend: "claude", apiKey: "" }, API, true));
    const host = new FakeElement() as unknown as HTMLElement;
    (view as unknown as { renderSetupCard(parent: HTMLElement): void }).renderSetupCard(host);
    const buttons = (host as unknown as FakeElement).querySelectorAll("button");
    expect(buttons.some((b) => b.textContent === "Use Claude Code sign-in")).toBe(true);
  });
});

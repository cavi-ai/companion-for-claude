import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { defaultChatControls } from "../../src/claude/chatControls";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";
import type { TurnRendererHost } from "../../src/view/turnRenderer";

const fakeElement = (): HTMLElement => new FakeElement() as unknown as HTMLElement;

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
});

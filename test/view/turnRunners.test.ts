import { App, FakeElement, getLastOpenedModal } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnDeps, AgentTurnHandlers } from "../../src/agent/loop";
import { defaultChatControls } from "../../src/claude/chatControls";
import type { Conversation } from "../../src/conversations/store";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { ToolUseBlock } from "../../src/providers/types";
import { ChatSession } from "../../src/view/chat/chatSession";
import { TurnRunners, type TurnRunnersDeps, type TurnRunnersHost } from "../../src/view/chat/turnRunners";

vi.mock("../../src/providers/chatTurn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/providers/chatTurn")>()),
  streamAttempt: vi.fn(async () => ({ text: "", trace: [] })),
}));
vi.mock("../../src/agent/loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agent/loop")>()),
  providerTurnRunner: vi.fn(),
}));
vi.mock("../../src/edit/reviewAndApply", () => ({ reviewAndApply: vi.fn() }));

const { streamAttempt } = await import("../../src/providers/chatTurn");
const { providerTurnRunner } = await import("../../src/agent/loop");
const { reviewAndApply } = await import("../../src/edit/reviewAndApply");

const THINKING_MODEL = "claude-sonnet-5-5";
const TEMPERATURE_MODEL = "claude-sonnet-4-5";
const handlers: AgentTurnHandlers = { onText: vi.fn() };
const emptyResult = { text: "", trace: [] };

function block(name: string, input: Record<string, unknown> = {}, extra: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return { type: "tool_use", id: "t1", name, input, ...extra };
}

function buttons(): FakeElement[] {
  return getLastOpenedModal()!.contentEl.querySelector(".cc-write-buttons")!.querySelectorAll("button") as unknown as FakeElement[];
}

function click(button: FakeElement): void {
  button.dispatchEvent({ type: "click" });
}

interface Rig {
  app: App;
  chat: ChatSession;
  plugin: TurnRunnersHost & { cliTurnRunner: ReturnType<typeof vi.fn>; interruptCliTurn: ReturnType<typeof vi.fn>; callExternalMcp: ReturnType<typeof vi.fn>; externalMcpTools: ReturnType<typeof vi.fn>; composeSystemPrompt: ReturnType<typeof vi.fn>; chatCapabilities: ReturnType<typeof vi.fn>; chatProvider: ReturnType<typeof vi.fn>; definitions: ReturnType<typeof vi.fn> };
  conversations: { activeId: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; saveEditProposal: ReturnType<typeof vi.fn>; clearEditProposal: ReturnType<typeof vi.fn> };
  deps: { [K in keyof TurnRunnersDeps]: ReturnType<typeof vi.fn> };
  runners: TurnRunners;
  seam: { agentTurn: TurnRunners["agentTurn"]; confirmAgentWrite(b: ToolUseBlock): Promise<boolean> };
}

function rig(): Rig {
  const app = new App();
  const chat = new ChatSession({ writes: () => false, setWrites: vi.fn(), save: async () => undefined, notify: vi.fn() });
  chat.controls = defaultChatControls(THINKING_MODEL);
  const conversations = {
    activeId: vi.fn(() => "active"),
    list: vi.fn((): Conversation[] => []),
    saveEditProposal: vi.fn(async () => undefined),
    clearEditProposal: vi.fn(async () => undefined),
  };
  const provider = { id: "anthropic", stream: vi.fn(async () => undefined) };
  const chatProvider = vi.fn(() => ({ provider, model: "provider-model" }));
  const chatCapabilities = vi.fn(() => ({ cli: false }));
  const definitions = vi.fn(() => []);
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    router: () => ({ anthropic: provider, chatProvider, chatCapabilities }),
    composeSystemPrompt: vi.fn(() => "system"),
    externalMcpTools: vi.fn(async () => []),
    agentTools: () => ({ definitions, unavailable: vi.fn(), call: vi.fn() }),
    conversations: () => conversations,
    cliTurnRunner: vi.fn(async () => ({ run: vi.fn(async () => emptyResult) })),
    interruptCliTurn: vi.fn(),
    callExternalMcp: vi.fn(async () => "external result"),
    chatCapabilities,
    chatProvider,
    definitions,
  } as unknown as Rig["plugin"];
  const deps = {
    turnOverrides: vi.fn(() => ({ model: null, maxTokens: null })),
    resumeCliSessionId: vi.fn((): string | null => null),
    conversationId: vi.fn((): string | null => "c1"),
    onWriteGrant: vi.fn(),
    renderRecoverableEdit: vi.fn(),
    removeEditRecovery: vi.fn(),
  } as Rig["deps"];
  const runners = new TurnRunners(app, plugin, chat, deps as unknown as TurnRunnersDeps);
  return { app, chat, plugin, conversations, deps, runners, seam: runners as unknown as Rig["seam"] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TurnRunners.streamTurn", () => {
  const sentRequest = () => vi.mocked(streamAttempt).mock.calls[0]![1];

  it("sends the shaped thinking fields to Claude and prefers the per-turn model", async () => {
    const { runners, chat, deps } = rig();
    chat.controls = { ...defaultChatControls(THINKING_MODEL), thinking: true };
    deps.turnOverrides.mockReturnValue({ model: "claude-opus-4-7", maxTokens: null });
    await runners.streamTurn("claude", [], handlers, new AbortController().signal);
    const request = sentRequest();
    expect(request.model).toBe("claude-opus-4-7");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.thinkingDisplay).toBe("summarized");
    expect(request.outputConfig).toBeDefined();
  });

  it("sends the temperature to Claude on a model that accepts it", async () => {
    const { runners, chat } = rig();
    chat.controls = { ...defaultChatControls(TEMPERATURE_MODEL), temperature: 0.3 };
    await runners.streamTurn("claude", [], handlers, new AbortController().signal);
    expect(sentRequest().temperature).toBe(0.3);
    expect(sentRequest().model).toBe(TEMPERATURE_MODEL);
  });

  it.each([
    ["thinking", { ...defaultChatControls(THINKING_MODEL), thinking: true }],
    ["temperature", { ...defaultChatControls(TEMPERATURE_MODEL), temperature: 0.3 }],
  ])("sends none of the Claude-only fields to the local backend (%s controls)", async (_label, controls) => {
    const { runners, chat, deps } = rig();
    chat.controls = controls;
    deps.turnOverrides.mockReturnValue({ model: "override-model", maxTokens: null });
    await runners.streamTurn("local", [], handlers, new AbortController().signal, { provider: { id: "ollama" } as never, model: "local-model" });
    const request = sentRequest();
    expect(request.model).toBe("local-model");
    for (const key of ["temperature", "thinking", "thinkingDisplay", "outputConfig"] as const) expect(request[key]).toBeUndefined();
  });

  it("composes a compact system prompt for the device provider", async () => {
    const { runners, plugin } = rig();
    await runners.streamTurn("local", [], handlers, new AbortController().signal, { provider: { id: "device" } as never, model: "m" });
    expect(plugin.composeSystemPrompt).toHaveBeenCalledWith({ project: null, compact: true });
  });

  it("uses the per-turn max-output override", async () => {
    const { runners, deps } = rig();
    deps.turnOverrides.mockReturnValue({ model: null, maxTokens: 777 });
    await runners.streamTurn("claude", [], handlers, new AbortController().signal);
    expect(sentRequest().maxTokens).toBe(777);
  });
});

describe("TurnRunners.agentTurn", () => {
  it("fetches external MCP tools only in chat mode", async () => {
    const { runners, chat, plugin } = rig();
    vi.mocked(providerTurnRunner).mockResolvedValue({ run: vi.fn(async () => emptyResult) } as never);
    chat.mode.setCapable(false);
    await runners.agentTurn([], handlers, new AbortController().signal, "c1");
    expect(plugin.externalMcpTools).not.toHaveBeenCalled();
    chat.mode.setCapable(true);
    await runners.agentTurn([], handlers, new AbortController().signal, "c1");
    expect(plugin.externalMcpTools).toHaveBeenCalledOnce();
  });

  it("returns aborted before reading the vault tool definitions when already stopped", async () => {
    const { runners, plugin } = rig();
    const controller = new AbortController();
    controller.abort();
    await expect(runners.agentTurn([], handlers, controller.signal)).resolves.toEqual({ text: "", trace: [], aborted: true });
    expect(plugin.definitions).not.toHaveBeenCalled();
  });

  it("resolves an error result when the CLI runner throws", async () => {
    const { runners, plugin } = rig();
    plugin.chatCapabilities.mockReturnValue({ cli: true });
    plugin.cliTurnRunner.mockRejectedValue(new Error("cli unavailable"));
    const result = await runners.agentTurn([], handlers, new AbortController().signal, "c1");
    expect(result.error?.message).toBe("cli unavailable");
  });

  it("uses the provider loop when the backend is not CLI", async () => {
    const { runners, plugin } = rig();
    const run = vi.fn(async () => ({ text: "answer", trace: [] }));
    vi.mocked(providerTurnRunner).mockResolvedValue({ run } as never);
    await expect(runners.agentTurn([], handlers, new AbortController().signal, "c1")).resolves.toEqual({ text: "answer", trace: [] });
    expect(providerTurnRunner).toHaveBeenCalledOnce();
    expect(plugin.cliTurnRunner).not.toHaveBeenCalled();
  });

  it("hands the CLI runner the full transcript, or none when a session is resumed", async () => {
    const { runners, chat, plugin, deps } = rig();
    plugin.chatCapabilities.mockReturnValue({ cli: true });
    chat.messages = [{ role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "now" }];
    await runners.agentTurn([], handlers, new AbortController().signal, "c1");
    const fresh = plugin.cliTurnRunner.mock.calls[0]![0] as { transcript: string; resumeSessionId?: string; conversationId: string };
    expect(fresh.transcript).toContain("first");
    expect(fresh.transcript).not.toContain("now");
    expect(fresh.resumeSessionId).toBeUndefined();
    expect(fresh.conversationId).toBe("c1");

    deps.resumeCliSessionId.mockReturnValue("session-9");
    await runners.agentTurn([], handlers, new AbortController().signal, "c1");
    const resumed = plugin.cliTurnRunner.mock.calls[1]![0] as { transcript: string; resumeSessionId?: string };
    expect(resumed.transcript).toBe("");
    expect(resumed.resumeSessionId).toBe("session-9");
  });

  it("interrupts the CLI turn when the signal aborts", async () => {
    const { runners, plugin } = rig();
    plugin.chatCapabilities.mockReturnValue({ cli: true });
    const controller = new AbortController();
    await runners.agentTurn([], handlers, controller.signal, "c1");
    expect(plugin.interruptCliTurn).not.toHaveBeenCalled();
    controller.abort();
    expect(plugin.interruptCliTurn).toHaveBeenCalledWith("c1");
  });
});

describe("TurnRunners write confirmation", () => {
  const confirmBlock = block("note_create", { path: "A.md", content: "x" });

  it("skips the modal when the session already granted writes", async () => {
    const { seam, chat } = rig();
    chat.writeGrant = true;
    await expect(seam.confirmAgentWrite(confirmBlock)).resolves.toBe(true);
    expect(getLastOpenedModal()).toBeUndefined();
  });

  it("grants the session and refreshes the pill on the always choice", async () => {
    const { seam, chat, deps } = rig();
    const pending = seam.confirmAgentWrite(confirmBlock);
    click(buttons()[1]!);
    await expect(pending).resolves.toBe(true);
    expect(chat.writeGrant).toBe(true);
    expect(deps.onWriteGrant).toHaveBeenCalledOnce();
  });

  it("resolves false on deny without granting", async () => {
    const { seam, chat, deps } = rig();
    const pending = seam.confirmAgentWrite(confirmBlock);
    click(buttons()[2]!);
    await expect(pending).resolves.toBe(false);
    expect(chat.writeGrant).toBe(false);
    expect(deps.onWriteGrant).not.toHaveBeenCalled();
  });
});

describe("TurnRunners external MCP tools", () => {
  async function execute(setup?: (r: Rig) => void) {
    const r = rig();
    r.chat.mode.setCapable(true);
    r.chat.writeGrant = true;
    setup?.(r);
    let captured!: AgentTurnDeps;
    vi.mocked(providerTurnRunner).mockImplementation(((deps: AgentTurnDeps) => {
      captured = deps;
      return { run: vi.fn(async () => emptyResult) };
    }) as never);
    const controller = new AbortController();
    await r.runners.agentTurn([], handlers, controller.signal, "c1");
    return { r, run: (b: ToolUseBlock, signal?: AbortSignal) => captured.execute(b, signal), controller };
  }
  const external = (extra: Partial<ToolUseBlock> = {}) => block("mcp__srv__tool", { a: 1 }, extra);

  it("returns the truncated result of a successful call", async () => {
    const { r, run } = await execute();
    await expect(run(external())).resolves.toEqual({ type: "tool_result", tool_use_id: "t1", content: "external result" });
    expect(r.plugin.callExternalMcp).toHaveBeenCalledWith("mcp__srv__tool", { a: 1 });
  });

  it("reports a parse error without calling the server", async () => {
    const { r, run } = await execute();
    await expect(run(external({ parseError: "bad json" }))).resolves.toMatchObject({ content: "bad json", is_error: true });
    expect(r.plugin.callExternalMcp).not.toHaveBeenCalled();
  });

  it("refuses to run after Stop", async () => {
    const { r, run } = await execute();
    const stopped = new AbortController();
    stopped.abort();
    await expect(run(external(), stopped.signal)).resolves.toMatchObject({ content: "Turn stopped before this tool ran.", is_error: true });
    expect(r.plugin.callExternalMcp).not.toHaveBeenCalled();
  });

  it("reports a declined confirmation", async () => {
    const { r, run } = await execute((rg) => { rg.chat.writeGrant = false; });
    const pending = run(external());
    click(buttons()[2]!);
    await expect(pending).resolves.toMatchObject({ content: "User declined.", is_error: true });
    expect(r.plugin.callExternalMcp).not.toHaveBeenCalled();
  });

  it("maps a throwing server to an error result", async () => {
    const { run } = await execute((rg) => { rg.plugin.callExternalMcp.mockRejectedValue(new Error("server down")); });
    await expect(run(external())).resolves.toMatchObject({ content: "server down", is_error: true });
  });
});

describe("TurnRunners edit proposals", () => {
  const edits = [{ old_str: "beta", new_str: "gamma" }];

  async function propose(r: Rig, input: Record<string, unknown>, conversationId = "c1", signal?: AbortSignal) {
    r.plugin.chatCapabilities.mockReturnValue({ cli: true });
    await r.runners.agentTurn([], handlers, signal ?? new AbortController().signal, conversationId);
    const call = r.plugin.cliTurnRunner.mock.calls[0]![0] as { deps: { proposeEdit(b: ToolUseBlock): Promise<string> } };
    return call.deps.proposeEdit(block("propose_note_edit", input));
  }

  it("throws when the path is missing", async () => {
    await expect(propose(rig(), { edits })).rejects.toThrow("propose_note_edit requires a 'path'.");
  });

  it("throws when the path is not a note", async () => {
    await expect(propose(rig(), { path: "missing.md", edits })).rejects.toThrow("Note not found: missing.md");
  });

  it("saves the proposal before opening the review", async () => {
    const r = rig();
    r.app.vault.seed("A.md", "alpha beta\n");
    const order: string[] = [];
    r.conversations.saveEditProposal.mockImplementation(async () => { order.push("save"); });
    vi.mocked(reviewAndApply).mockImplementation((async () => { order.push("review"); return { applied: 1, total: 1, remaining: [], cancelled: false }; }) as never);
    const message = await propose(r, { path: "A.md", edits, description: "d" });
    expect(order).toEqual(["save", "review"]);
    expect(r.conversations.saveEditProposal).toHaveBeenCalledWith("c1", { path: "A.md", edits, description: "d" });
    expect(message).toBe("Applied all 1 edit to A.md.");
  });
});

describe("TurnRunners reviewLastProposedEdit", () => {
  const conversation = {
    id: "c1", title: "t", createdAt: 1, updatedAt: 2, messages: [],
    lastEditProposal: { path: "A.md", edits: [{ old_str: "beta", new_str: "gamma" }], proposedAt: 2 },
  } satisfies Conversation;

  function reviewRig() {
    const r = rig();
    r.app.vault.seed("A.md", "alpha beta\n");
    r.conversations.list.mockReturnValue([conversation]);
    return r;
  }

  it("renders the recoverable edit on cancel only for the shown conversation", async () => {
    const r = reviewRig();
    vi.mocked(reviewAndApply).mockResolvedValue({ applied: 0, total: 1, remaining: conversation.lastEditProposal.edits, cancelled: true });
    await r.runners.reviewLastProposedEdit(conversation);
    expect(r.deps.renderRecoverableEdit).toHaveBeenCalledWith(conversation);

    r.deps.renderRecoverableEdit.mockClear();
    r.deps.conversationId.mockReturnValue("other");
    await r.runners.reviewLastProposedEdit(conversation);
    expect(r.deps.renderRecoverableEdit).not.toHaveBeenCalled();
  });

  it("clears the proposal and the recovery row when every edit applied", async () => {
    const r = reviewRig();
    vi.mocked(reviewAndApply).mockResolvedValue({ applied: 1, total: 1, remaining: [], cancelled: false });
    await r.runners.reviewLastProposedEdit(conversation);
    expect(r.conversations.clearEditProposal).toHaveBeenCalledWith("c1");
    expect(r.deps.removeEditRecovery).toHaveBeenCalledOnce();
  });

  it("keeps the remaining edits when only some applied", async () => {
    const r = reviewRig();
    const remaining = [{ old_str: "x", new_str: "y" }];
    vi.mocked(reviewAndApply).mockResolvedValue({ applied: 1, total: 2, remaining, cancelled: false });
    await r.runners.reviewLastProposedEdit(conversation);
    expect(r.conversations.saveEditProposal).toHaveBeenCalledWith("c1", { path: "A.md", edits: remaining });
    expect(r.conversations.clearEditProposal).not.toHaveBeenCalled();
    expect(r.deps.removeEditRecovery).not.toHaveBeenCalled();
  });

  it("clears the stored proposal on discard", async () => {
    const r = reviewRig();
    await r.runners.discardLastProposedEdit(conversation);
    expect(r.conversations.clearEditProposal).toHaveBeenCalledWith("c1");
  });
});

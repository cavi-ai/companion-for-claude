import { describe, it, expect, vi } from "vitest";
import { runAgentTurn, type AgentTurnDeps } from "../src/agent/loop";
import type { StreamHandlers } from "../src/types";
import type { CompletionRequest, ToolResultBlock, ToolUseBlock } from "../src/providers/types";

/** One scripted model response for the fake provider. */
interface Scripted {
  text?: string;
  toolUses?: ToolUseBlock[];
  stopReason?: string;
  error?: string;
}

const use = (id: string, name = "vault_search", input: Record<string, unknown> = { query: "x" }): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

function fakeStream(script: Scripted[]): { stream: AgentTurnDeps["stream"]; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const stream = async (req: CompletionRequest, handlers: StreamHandlers): Promise<void> => {
    calls.push(structuredClone(req));
    const step = script.shift();
    if (!step) throw new Error("fake script exhausted");
    if (step.error) {
      handlers.onError?.(new Error(step.error));
      return;
    }
    if (step.text) handlers.onText(step.text);
    for (const tu of step.toolUses ?? []) handlers.onToolUse?.(tu);
    if (step.stopReason) handlers.onStopReason?.(step.stopReason);
    handlers.onDone?.(step.text ?? "");
  };
  return { stream, calls };
}

const okResult = (id: string, content = "result text"): ToolResultBlock => ({ type: "tool_result", tool_use_id: id, content });

const baseReq: CompletionRequest = {
  system: "sys",
  messages: [{ role: "user", content: "question" }],
  model: "m",
  maxTokens: 100,
};

function deps(script: Scripted[], overrides: Partial<AgentTurnDeps> = {}) {
  const { stream, calls } = fakeStream(script);
  const execute = vi.fn(async (b: ToolUseBlock) => okResult(b.id));
  return { deps: { stream, execute, maxIterations: 10, ...overrides } as AgentTurnDeps, calls, execute };
}

describe("runAgentTurn", () => {
  it("plain answer: one iteration, no tools executed", async () => {
    const { deps: d, calls, execute } = deps([{ text: "hello", stopReason: "end_turn" }]);
    const onText = vi.fn();
    const r = await runAgentTurn(d, baseReq, { onText });
    expect(r.text).toBe("hello");
    expect(r.trace).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(onText).toHaveBeenCalledWith("hello");
  });

  it("tool round-trip: executes, feeds tool_result back, concatenates text", async () => {
    const { deps: d, calls, execute } = deps([
      { text: "Let me look.", toolUses: [use("t1")], stopReason: "tool_use" },
      { text: "Found it.", stopReason: "end_turn" },
    ]);
    const r = await runAgentTurn(d, baseReq, { onText: vi.fn() });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("Let me look.\n\nFound it.");
    expect(r.trace).toEqual([{ name: "vault_search", argsSummary: '{"query":"x"}', resultPreview: "result text", ok: true }]);
    // second request carries the assistant blocks + tool_result user turn
    const second = calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } },
      ],
    });
    expect(second.messages[2]).toEqual({ role: "user", content: [okResult("t1")] });
  });

  it("omits the empty text block when the model goes straight to tools", async () => {
    const { deps: d, calls } = deps([
      { toolUses: [use("t1")], stopReason: "tool_use" },
      { text: "done", stopReason: "end_turn" },
    ]);
    await runAgentTurn(d, baseReq, { onText: vi.fn() });
    const assistant = calls[1]!.messages[1]!;
    expect(assistant.content).toEqual([{ type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } }]);
  });

  it("executes parallel tool calls in arrival order", async () => {
    const { deps: d, calls, execute } = deps([
      { toolUses: [use("t1", "vault_search"), use("t2", "list_recent", { limit: 5 })], stopReason: "tool_use" },
      { text: "done", stopReason: "end_turn" },
    ]);
    await runAgentTurn(d, baseReq, { onText: vi.fn() });
    expect(execute.mock.calls.map((c) => c[0].id)).toEqual(["t1", "t2"]);
    const results = calls[1]!.messages[2]!;
    expect((results.content as ToolResultBlock[]).map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
  });

  it("continues after an is_error tool result", async () => {
    const { deps: d } = deps([
      { toolUses: [use("t1", "note_read", { path: "missing.md" })], stopReason: "tool_use" },
      { text: "That note doesn't exist.", stopReason: "end_turn" },
    ]);
    d.execute = vi.fn(async (b: ToolUseBlock) => ({ type: "tool_result", tool_use_id: b.id, content: "Note not found", is_error: true }));
    const r = await runAgentTurn(d, baseReq, { onText: vi.fn() });
    expect(r.text).toContain("doesn't exist");
    expect(r.trace[0]).toMatchObject({ ok: false });
  });

  it("stops at the iteration cap with a notice", async () => {
    const always: Scripted[] = Array.from({ length: 5 }, (_, i) => ({ toolUses: [use(`t${i}`)], stopReason: "tool_use" }));
    const { deps: d, calls } = deps(always, { maxIterations: 2 });
    const onNotice = vi.fn();
    const r = await runAgentTurn(d, baseReq, { onText: vi.fn(), onNotice });
    expect(calls).toHaveLength(2);
    expect(onNotice).toHaveBeenCalledOnce();
    expect(r.capped).toBe(true);
  });

  it("aborts between iterations without a further stream call", async () => {
    const ac = new AbortController();
    const { deps: d, calls } = deps([{ toolUses: [use("t1")], stopReason: "tool_use" }, { text: "never", stopReason: "end_turn" }]);
    d.execute = vi.fn(async (b: ToolUseBlock) => {
      ac.abort();
      return okResult(b.id);
    });
    d.signal = ac.signal;
    const r = await runAgentTurn(d, baseReq, { onText: vi.fn() });
    expect(r.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a mid-loop stream error and keeps prior text", async () => {
    const { deps: d } = deps([
      { text: "Working. ", toolUses: [use("t1")], stopReason: "tool_use" },
      { error: "Anthropic API 529: overloaded" },
    ]);
    const r = await runAgentTurn(d, baseReq, { onText: vi.fn() });
    expect(r.error?.message).toContain("overloaded");
    expect(r.text).toBe("Working. ");
  });

  it("forwards usage, thinking, and truncation handlers", async () => {
    const { stream } = fakeStream([]);
    void stream;
    const d: AgentTurnDeps = {
      stream: async (_req, handlers) => {
        handlers.onThinking?.("pondering");
        handlers.onUsage?.({ input_tokens: 10, output_tokens: 2 });
        handlers.onText("hi");
        handlers.onStopReason?.("end_turn");
        handlers.onDone?.("hi");
      },
      execute: vi.fn(),
      maxIterations: 10,
    };
    const onThinking = vi.fn();
    const onUsage = vi.fn();
    await runAgentTurn(d, baseReq, { onText: vi.fn(), onThinking, onUsage });
    expect(onThinking).toHaveBeenCalledWith("pondering");
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 2 });
  });
});

describe("runAgentTurn with rejected edit proposals", () => {
  it("continues the loop after a rejected propose_note_edit", async () => {
    const script: Scripted[] = [
      { toolUses: [use("t1", "propose_note_edit", { path: "A.md", edits: [{ old_str: "a", new_str: "b" }] })], stopReason: "tool_use" },
      { text: "Understood — leaving the note as is.", stopReason: "end_turn" },
    ];
    const calls: CompletionRequest[] = [];
    const stream = async (req: CompletionRequest, handlers: StreamHandlers): Promise<void> => {
      calls.push(structuredClone(req));
      const step = script.shift()!;
      if (step.text) handlers.onText(step.text);
      for (const tu of step.toolUses ?? []) handlers.onToolUse?.(tu);
      if (step.stopReason) handlers.onStopReason?.(step.stopReason);
      handlers.onDone?.(step.text ?? "");
    };
    const execute = vi.fn(async (b: ToolUseBlock): Promise<ToolResultBlock> => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: "User rejected the proposed edit.",
    }));
    const r = await runAgentTurn({ stream, execute, maxIterations: 10 }, baseReq, { onText: vi.fn() });
    expect(r.text).toContain("leaving the note as is");
    // The rejection is an ordinary (non-error) result the model can react to.
    expect((calls[1]!.messages[2]!.content as ToolResultBlock[])[0]!.content).toContain("rejected");
    expect(r.trace[0]).toMatchObject({ name: "propose_note_edit", ok: true });
  });
});

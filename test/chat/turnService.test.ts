import { describe, expect, it, vi } from "vitest";
import { ChatTurnService, type TurnEvent, type TurnMessage } from "../../src/chat/turnService";
import type { AgentTurnHandlers, AgentTurnResult } from "../../src/agent/loop";
import type { ToolUseBlock } from "../../src/providers/types";

function deps(overrides?: Partial<{ completeTurn: () => Promise<void>; interruptTurn: () => Promise<void> }>) {
  return {
    completeTurn: vi.fn().mockResolvedValue(undefined),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    registerTurn: vi.fn((_stop: () => void) => () => undefined),
    ...overrides,
  };
}

const TOOL_BLOCK: ToolUseBlock = { type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } };

describe("ChatTurnService", () => {
  it("(a) unsubscribing does not abort the run and done still persists", async () => {
    const service = new ChatTurnService();
    const d = deps();
    let resolveRun!: (r: AgentTurnResult) => void;
    const run = vi.fn((handlers: AgentTurnHandlers, _signal: AbortSignal) => {
      handlers.onText("hello");
      return new Promise<AgentTurnResult>((resolve) => {
        resolveRun = resolve;
      });
    });

    const handle = service.start("c1", { turnId: "t1", title: "Chat", run, ...d });
    const unsubscribe = service.subscribe("c1", () => undefined);
    unsubscribe();

    resolveRun({ text: "hello", trace: [] });
    const result = await handle.result;

    expect(result).toEqual({ text: "hello", trace: [] });
    expect(d.completeTurn).toHaveBeenCalledWith({ text: "hello", trace: [] });
    expect(d.interruptTurn).not.toHaveBeenCalled();
  });

  it("(b) subscribing mid-turn replays buffered text and tool events in order, then receives live ones", async () => {
    const service = new ChatTurnService();
    const d = deps();
    let handlersRef!: AgentTurnHandlers;
    let resolveRun!: (r: AgentTurnResult) => void;
    const run = vi.fn((handlers: AgentTurnHandlers) => {
      handlersRef = handlers;
      return new Promise<AgentTurnResult>((resolve) => {
        resolveRun = resolve;
      });
    });

    const handle = service.start("c1", { turnId: "t1", title: "Chat", run, ...d });
    handlersRef.onText("a");
    handlersRef.onToolStart?.(TOOL_BLOCK);

    const received: TurnMessage[] = [];
    service.subscribe("c1", (msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      kind: "replay",
      events: [
        { kind: "text", delta: "a" },
        { kind: "toolStart", block: TOOL_BLOCK },
      ],
    });

    handlersRef.onText("b");
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ kind: "text", delta: "b" });

    resolveRun({ text: "ab", trace: [] });
    await handle.result;
  });

  it("(c) onUnattachedDone fires only when no subscriber is attached at completion", async () => {
    const service = new ChatTurnService();
    const unattached = vi.fn();
    service.onUnattachedDone(unattached);

    // Turn 1: nobody subscribes — fires.
    let resolve1!: (r: AgentTurnResult) => void;
    const handle1 = service.start("c1", {
      turnId: "t1",
      title: "Unwatched",
      run: () => new Promise((r) => (resolve1 = r)),
      ...deps(),
    });
    resolve1({ text: "done", trace: [] });
    await handle1.result;
    expect(unattached).toHaveBeenCalledTimes(1);
    expect(unattached).toHaveBeenCalledWith({ conversationId: "c1", turnId: "t1", title: "Unwatched", result: { text: "done", trace: [] } });

    // Turn 2: a subscriber is attached — does not fire again.
    let resolve2!: (r: AgentTurnResult) => void;
    const handle2 = service.start("c2", {
      turnId: "t2",
      title: "Watched",
      run: () => new Promise((r) => (resolve2 = r)),
      ...deps(),
    });
    const unsub = service.subscribe("c2", () => undefined);
    resolve2({ text: "done", trace: [] });
    await handle2.result;
    expect(unattached).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("(d) stop() aborts and results in interruptTurn", async () => {
    const service = new ChatTurnService();
    const d = deps();
    const run = vi.fn((_handlers: AgentTurnHandlers, signal: AbortSignal) => {
      return new Promise<AgentTurnResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ text: "partial", trace: [], aborted: true }));
      });
    });

    const handle = service.start("c1", { turnId: "t1", title: "Chat", run, ...d });
    service.stop("c1");
    const result = await handle.result;

    expect(result.aborted).toBe(true);
    expect(d.interruptTurn).toHaveBeenCalledWith({ text: "partial", trace: [], aborted: true }, undefined);
    expect(d.completeTurn).not.toHaveBeenCalled();
  });

  it("(e) a runner rejection results in interruptTurn with the error and an error event", async () => {
    const service = new ChatTurnService();
    const d = deps();
    const boom = new Error("boom");
    const run = vi.fn(() => Promise.reject(boom));

    const received: TurnEvent[] = [];
    const handle = service.start("c1", { turnId: "t1", title: "Chat", run, ...d });
    service.subscribe("c1", (msg) => {
      if (msg.kind !== "replay") received.push(msg);
    });

    await expect(handle.result).rejects.toThrow("boom");
    expect(d.interruptTurn).toHaveBeenCalledWith({ text: "", trace: [], error: boom }, boom);
    expect(received.some((e) => e.kind === "error" && e.error === boom)).toBe(true);
  });

  it("registers the stop callback and unregisters it once the turn settles", async () => {
    const service = new ChatTurnService();
    const unregister = vi.fn();
    const registerTurn = vi.fn(() => unregister);
    let resolveRun!: (r: AgentTurnResult) => void;
    const handle = service.start("c1", {
      turnId: "t1",
      title: "Chat",
      run: () => new Promise((r) => (resolveRun = r)),
      ...deps(),
      registerTurn,
    });

    expect(registerTurn).toHaveBeenCalledTimes(1);
    resolveRun({ text: "x", trace: [] });
    await handle.result;
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("live() reports the running turn and null once it settles", async () => {
    const service = new ChatTurnService();
    let resolveRun!: (r: AgentTurnResult) => void;
    const handle = service.start("c1", {
      turnId: "t1",
      title: "My chat",
      run: () => new Promise((r) => (resolveRun = r)),
      ...deps(),
    });

    expect(service.live("c1")).toEqual({ turnId: "t1", title: "My chat" });
    resolveRun({ text: "x", trace: [] });
    await handle.result;
    expect(service.live("c1")).toBeNull();
  });

  it("subscribe() on a conversation with no live turn is a no-op", () => {
    const service = new ChatTurnService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe("nope", listener);
    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});

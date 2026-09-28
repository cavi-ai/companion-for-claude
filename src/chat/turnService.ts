import { toTraceEntry, type AgentTurnHandlers, type AgentTurnResult } from "../agent/loop";
import type { ToolResultBlock, ToolUseBlock } from "../providers/types";

type UsageArg = Parameters<NonNullable<AgentTurnHandlers["onUsage"]>>[0];

export type TurnEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolStart"; block: ToolUseBlock }
  | { kind: "toolResult"; block: ToolUseBlock; result: ToolResultBlock }
  | { kind: "notice"; text: string }
  | { kind: "usage"; usage: UsageArg }
  | { kind: "truncated" }
  | { kind: "done"; result: AgentTurnResult }
  | { kind: "error"; error: Error };

/** Every subscriber first receives the buffered replay, then live events as they happen. */
export type TurnMessage = { kind: "replay"; events: TurnEvent[] } | TurnEvent;

export type TurnListener = (message: TurnMessage) => void;

export interface TurnHandle {
  turnId: string;
  /** Resolves once, whether the turn completed, was interrupted, or errored. */
  result: Promise<AgentTurnResult>;
}

export interface TurnSnapshot {
  turnId: string;
  title: string;
}

export interface StartTurnInput {
  turnId: string;
  title: string;
  run: (handlers: AgentTurnHandlers, signal: AbortSignal) => Promise<AgentTurnResult>;
  /** Persists a successful/aborted-but-not-erroring turn — matches conversations/controller.completeTurn. */
  completeTurn: (result: AgentTurnResult) => Promise<void>;
  /** Persists a turn stopped by the tool-iteration cap (receipt + handoff survive for Continue). */
  capTurn?: (result: AgentTurnResult) => Promise<void>;
  /** Persists an interrupted or errored turn — matches conversations/controller.interruptTurn. */
  interruptTurn: (result: AgentTurnResult, error?: Error) => Promise<void>;
  /** Registers the abort callback with the cross-view stop path (conversations/controller.registerTurn). */
  registerTurn: (stop: () => void) => () => void;
}

interface UnattachedDoneInfo {
  conversationId: string;
  turnId: string;
  title: string;
  result: AgentTurnResult;
}

/** Text buffered for replay is capped (kept as the tail) — tool/notice/usage events are small and unbounded. */
const TEXT_BUFFER_CAP = 20000;

interface LiveTurn {
  turnId: string;
  title: string;
  controller: AbortController;
  events: TurnEvent[];
  subscribers: Set<TurnListener>;
  result: Promise<AgentTurnResult>;
}

/**
 * Owns in-flight chat turns independent of any ChatView instance: a turn keeps
 * streaming (and persisting) after its view closes, and a subscriber attaching
 * later — a reopened view — replays what it missed before continuing live.
 * No Obsidian imports; deps (persistence, cross-view stop) are injected per turn.
 */
export class ChatTurnService {
  private readonly liveTurns = new Map<string, LiveTurn>();
  private unattachedListeners: Array<(info: UnattachedDoneInfo) => void> = [];

  start(conversationId: string, input: StartTurnInput): TurnHandle {
    const controller = new AbortController();
    const turn: LiveTurn = {
      turnId: input.turnId,
      title: input.title,
      controller,
      events: [],
      subscribers: new Set(),
      result: Promise.resolve({ text: "", trace: [] }),
    };

    const push = (event: TurnEvent): void => {
      this.buffer(turn, event);
      for (const listener of turn.subscribers) listener(event);
    };
    const emit = (event: TurnEvent): void => { if (!controller.signal.aborted) push(event); };

    const handlers: AgentTurnHandlers = {
      onText: (delta) => emit({ kind: "text", delta }),
      onThinking: (delta) => emit({ kind: "thinking", delta }),
      onUsage: (usage) => emit({ kind: "usage", usage }),
      onTruncated: () => emit({ kind: "truncated" }),
      onToolStart: (block) => emit({ kind: "toolStart", block }),
      onToolResult: (block, result) => emit({ kind: "toolResult", block, result }),
      onNotice: (text) => emit({ kind: "notice", text }),
    };

    const unregister = input.registerTurn(() => controller.abort());
    let running: Promise<AgentTurnResult>;
    try { running = input.run(handlers, controller.signal); }
    catch (error) { running = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    let removeAbort: () => void = () => undefined;
    const interrupted = new Promise<AgentTurnResult>((resolve) => {
      const onAbort = (): void => resolve({
        text: turn.events.filter((event): event is Extract<TurnEvent, { kind: "text" }> => event.kind === "text").map((event) => event.delta).join(""),
        trace: turn.events.filter((event): event is Extract<TurnEvent, { kind: "toolResult" }> => event.kind === "toolResult").map((event) => toTraceEntry(event.block, event.result)),
        aborted: true,
      });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) onAbort();
    });

    turn.result = Promise.race([running, interrupted])
      .then(async (result) => {
        push({ kind: "done", result });
        if (result.aborted || result.error) await input.interruptTurn(result, result.error);
        else if (result.capped && input.capTurn) await input.capTurn(result);
        else await input.completeTurn(result);
        this.settle(conversationId, turn, result);
        return result;
      })
      .catch(async (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        const result: AgentTurnResult = { text: "", trace: [], error: err };
        push({ kind: "error", error: err });
        await input.interruptTurn(result, err);
        this.settle(conversationId, turn, result);
        throw err;
      })
      .finally(() => { removeAbort(); unregister(); });

    // A turn already live for this conversation is superseded — its own
    // settle() no-ops (this.liveTurns no longer points at it) once it finishes.
    this.liveTurns.set(conversationId, turn);
    return { turnId: turn.turnId, result: turn.result };
  }

  private settle(conversationId: string, turn: LiveTurn, result: AgentTurnResult): void {
    if (this.liveTurns.get(conversationId) !== turn) return;
    this.liveTurns.delete(conversationId);
    if (turn.subscribers.size === 0) {
      for (const listener of this.unattachedListeners) {
        listener({ conversationId, turnId: turn.turnId, title: turn.title, result });
      }
    }
  }

  private buffer(turn: LiveTurn, event: TurnEvent): void {
    if (event.kind === "text" || event.kind === "thinking") {
      const last = turn.events[turn.events.length - 1];
      if (last && last.kind === event.kind) {
        last.delta = (last.delta + event.delta).slice(-TEXT_BUFFER_CAP);
        return;
      }
    }
    turn.events.push(event);
  }

  /** Replays what's buffered so far, then delivers live events until unsubscribed. No-op if the turn isn't live. */
  subscribe(conversationId: string, listener: TurnListener): () => void {
    const turn = this.liveTurns.get(conversationId);
    if (!turn) return () => undefined;
    listener({ kind: "replay", events: [...turn.events] });
    turn.subscribers.add(listener);
    return () => {
      turn.subscribers.delete(listener);
    };
  }

  stop(conversationId: string): void {
    this.liveTurns.get(conversationId)?.controller.abort();
  }

  live(conversationId: string): TurnSnapshot | null {
    const turn = this.liveTurns.get(conversationId);
    return turn ? { turnId: turn.turnId, title: turn.title } : null;
  }

  /** Fires once per turn that finishes with no subscriber attached at that moment. */
  onUnattachedDone(callback: (info: UnattachedDoneInfo) => void): () => void {
    this.unattachedListeners.push(callback);
    return () => {
      this.unattachedListeners = this.unattachedListeners.filter((cb) => cb !== callback);
    };
  }
}

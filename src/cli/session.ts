// One CLI process per conversation (persistent backends) or per turn (per-turn backends); the CLI runs the tools, this class renders the turn. Pure: the spawn is injected.

import type { AgentTurnHandlers, AgentTurnResult, AgentTurnRunner } from "../agent/loop";
import { toTraceEntry } from "../agent/loop";
import type { CompletionRequest, ContentBlock, ToolResultBlock, ToolUseBlock } from "../providers/types";
import type { ToolTraceEntry } from "../types";
import { StreamJsonParser, type CliEvent } from "./streamJson";
import type { CliArgvInput, CliBackend } from "./backends/types";

export interface CliChildStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
}

export interface CliChild {
  stdin: { write(chunk: string, cb?: (err?: Error | null) => void): unknown; end(): void };
  stdout: CliChildStream;
  stderr: CliChildStream;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: string): boolean;
}

export type CliSpawn = () => CliChild;
export type CliTurnSpawn = (argv: string[], env: Record<string, string> | undefined) => CliChild;

export interface CliSessionDeps {
  backend: CliBackend;
  /** Persistent backends: spawns the one long-lived process; argv/env are already baked in by the caller. */
  spawn?: CliSpawn;
  /** Per-turn backends: spawns a fresh process for this turn's fully-built argv/env. */
  spawnTurn?: CliTurnSpawn;
  /** Per-turn backends: the argv fields that stay the same turn to turn (model, mcp config, allowed tools, max turns, cwd). */
  argvTemplate?: Omit<CliArgvInput, "message" | "systemPromptText" | "resumeSessionId" | "sessionId">;
  /** Per-turn backends: an already-known CLI session id to resume, when this conversation was previously running on this backend. */
  initialSessionId?: string;
  /** Persistent: prepended to the first stdin message (conversation transcript). Per-turn: folded into the first turn's message, alongside `systemPromptText`, when there is no session to resume. */
  transcript?: string;
  /** Per-turn backends only: the system prompt, prepended to the first turn's message (no system-prompt-file flag exists on these CLIs). */
  systemPromptText?: string;
  /** Fired whenever a new (non-empty, changed) CLI session id is learned — per-turn backends generate their own, so the caller persists it here rather than upfront. */
  onSessionId?: (id: string) => void;
  /** Silence before a "still waiting" notice; the watchdog is paused while a tool is pending. */
  idleNoticeMs?: number;
  /** Silence before the turn is aborted as unresponsive. */
  idleAbortMs?: number;
}

const STDERR_TAIL = 500;
const CLOSE_GRACE_MS = 3000;
const INTERRUPT_TERM_MS = 1500;
const INTERRUPT_KILL_MS = 3000;
const IDLE_NOTICE_MS = 60_000;
const IDLE_ABORT_MS = 300_000;

/** The stream-json line for the request's last user message (text, image, document blocks) — persistent backends only. */
export function userMessageLine(req: CompletionRequest, transcript: string | null): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const blocks: ContentBlock[] = last === undefined ? [] : typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.filter((b) => b.type === "text" || b.type === "image" || b.type === "document");
  const content = transcript ? [{ type: "text", text: transcript } as ContentBlock, ...blocks] : blocks;
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** The plain text of the request's last user message — per-turn backends take the prompt as a CLI argument, text only. */
export function plainUserMessageText(req: CompletionRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  if (last === undefined) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n\n");
}

interface ActiveTurn {
  handlers: AgentTurnHandlers;
  settle: (result: AgentTurnResult) => void;
  segments: string[];
  current: string;
  trace: ToolTraceEntry[];
  pending: Map<string, ToolUseBlock>;
}

export class CliSession implements AgentTurnRunner {
  private child: CliChild | null = null;
  private parser: StreamJsonParser;
  private stderrTail = "";
  private id: string | null;
  private active: ActiveTurn | null = null;
  private closed = false;
  private firstMessage = true;
  private exitWaiters: Array<() => void> = [];
  private shutdownTimers: number[] = [];
  private idleNoticeTimer: number | null = null;
  private idleAbortTimer: number | null = null;

  constructor(private readonly deps: CliSessionDeps) {
    this.parser = new StreamJsonParser((line) => deps.backend.parseLine(line));
    this.id = deps.initialSessionId ?? null;
  }

  sessionId(): string | null {
    return this.id;
  }

  isClosed(): boolean {
    return this.closed;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  run(req: CompletionRequest, handlers: AgentTurnHandlers): Promise<AgentTurnResult> {
    if (this.closed) return Promise.reject(new Error(`This ${this.deps.backend.label} session is closed.`));
    if (this.active) return Promise.reject(new Error("A turn is already running in this conversation."));
    return this.deps.backend.processModel === "per-turn" ? this.runPerTurn(req, handlers) : this.runPersistent(req, handlers);
  }

  private runPersistent(req: CompletionRequest, handlers: AgentTurnHandlers): Promise<AgentTurnResult> {
    const spawn = this.deps.spawn;
    if (!spawn) return Promise.reject(new Error(`${this.deps.backend.label} session is missing its spawn function.`));
    if (!this.child) this.child = this.attach(spawn());
    const child = this.child;
    return new Promise<AgentTurnResult>((resolve) => {
      const turn = this.beginTurn(handlers, resolve);
      const line = userMessageLine(req, this.firstMessage ? this.deps.transcript ?? null : null);
      this.firstMessage = false;
      child.stdin.write(line, (err) => {
        if (err) turn.settle({ text: "", trace: [], error: new Error(`Could not write to ${this.deps.backend.label}: ${err.message}`) });
      });
    });
  }

  private runPerTurn(req: CompletionRequest, handlers: AgentTurnHandlers): Promise<AgentTurnResult> {
    const { backend, spawnTurn, argvTemplate } = this.deps;
    if (!spawnTurn || !argvTemplate) return Promise.reject(new Error(`${backend.label} session is missing its per-turn spawn function.`));
    const resuming = this.id !== null;
    const prefix = !resuming ? this.firstTurnPrefix() : undefined;
    const input: CliArgvInput = {
      ...argvTemplate,
      message: plainUserMessageText(req),
      ...(resuming ? { resumeSessionId: this.id! } : {}),
      ...(prefix ? { systemPromptText: prefix } : {}),
    };
    const argv = backend.buildArgv(input);
    const env = backend.env?.(input);
    this.child = this.attach(spawnTurn(argv, env));
    this.firstMessage = false;
    return new Promise<AgentTurnResult>((resolve) => this.beginTurn(handlers, resolve));
  }

  /** Per-turn only: the system prompt and any conversation transcript, folded into the very first turn's message. */
  private firstTurnPrefix(): string | undefined {
    const parts = [this.deps.systemPromptText, this.deps.transcript].filter((s): s is string => !!s && s.trim().length > 0);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private beginTurn(handlers: AgentTurnHandlers, resolve: (r: AgentTurnResult) => void): ActiveTurn {
    const turn: ActiveTurn = { handlers, settle: (r) => this.finish(turn, r, resolve), segments: [], current: "", trace: [], pending: new Map() };
    this.active = turn;
    this.armIdleWatchdog();
    return turn;
  }

  interrupt(): void {
    const child = this.child;
    if (!child) return;
    // Persistent: a process that ignores SIGINT must never strand Chat, so the whole session ends.
    // Per-turn: each turn is a fresh process anyway, so only this turn's child is torn down.
    if (this.deps.backend.processModel !== "per-turn") this.closed = true;
    if (this.active) this.active.settle({ text: this.text(this.active), trace: this.active.trace, aborted: true });
    child.kill("SIGINT");
    this.clearShutdownTimers();
    this.shutdownTimers = [
      window.setTimeout(() => { if (this.child === child) child.kill("SIGTERM"); }, INTERRUPT_TERM_MS),
      window.setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, INTERRUPT_KILL_MS),
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimers();
    const child = this.child;
    if (!child) return;
    this.clearShutdownTimers();
    this.child = null;
    if (this.active) this.active.settle({ text: this.text(this.active), trace: this.active.trace, aborted: true });
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = window.setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
    await exited;
    window.clearTimeout(timer);
  }

  private attach(child: CliChild): CliChild {
    child.stdout.on("data", (chunk) => {
      for (const ev of this.parser.push(String(chunk))) this.onEvent(ev);
      this.armIdleWatchdog(); // any bytes are life, including lines the parser drops
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL);
      this.armIdleWatchdog();
    });
    child.on("error", (err) => this.onChildExit(child, `${this.deps.backend.label} failed to start: ${err.message}`, null));
    child.on("exit", (code) => this.onChildExit(child, `${this.deps.backend.label} exited (code ${code ?? "?"}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim()}` : ""}`, code ?? null));
    return child;
  }

  private onChildExit(child: CliChild, message: string, code: number | null): void {
    if (this.child === child) this.child = null; // only clear if this exit belongs to the current process
    this.clearShutdownTimers();
    for (const w of this.exitWaiters.splice(0)) w();
    const turn = this.active;
    if (this.deps.backend.processModel !== "per-turn") {
      // A persistent process that died for any reason ends the session.
      this.closed = true;
      this.clearIdleTimers();
      if (turn) turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(message) });
      return;
    }
    // Per-turn: exit is the normal way a turn ends. A turn already settled by
    // a result event leaves `active` null here — nothing left to do.
    if (!turn) return;
    this.clearIdleTimers();
    if (code === 0) turn.settle({ text: this.text(turn), trace: turn.trace });
    else turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(message) });
  }

  private text(turn: ActiveTurn): string {
    return [...turn.segments, turn.current].filter((s) => s.trim().length > 0).join("\n\n");
  }

  private finish(turn: ActiveTurn, result: AgentTurnResult, resolve: (r: AgentTurnResult) => void): void {
    if (this.active !== turn) return;
    this.clearIdleTimers();
    this.active = null;
    resolve(result);
  }

  private setId(id: string): void {
    const changed = id !== "" && id !== this.id;
    this.id = id;
    if (changed) this.deps.onSessionId?.(id);
  }

  private onEvent(ev: CliEvent): void {
    const turn = this.active;
    if (ev.kind === "init") {
      this.setId(ev.sessionId);
      const down = ev.mcp.find((m) => m.status !== "connected");
      if (down && turn) {
        turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(`MCP bridge not connected (${down.name}: ${down.status})`) });
        this.interrupt();
      }
      return;
    }
    // Backends without a distinct init/session-start event (opencode) carry the session id on results instead.
    if (ev.kind === "result" && ev.sessionId) this.setId(ev.sessionId);
    if (!turn) return;
    switch (ev.kind) {
      case "text":
        turn.current += ev.delta;
        turn.handlers.onText(ev.delta);
        return;
      case "thinking":
        turn.handlers.onThinking?.(ev.delta);
        return;
      case "usage":
        turn.handlers.onUsage?.(ev.usage);
        return;
      case "retry":
        turn.handlers.onNotice?.(`Retrying (${ev.attempt}) — ${ev.error}`);
        return;
      case "toolUse":
        turn.pending.set(ev.block.id, ev.block);
        turn.handlers.onToolStart?.(ev.block);
        return;
      case "toolResult": {
        const block = turn.pending.get(ev.id);
        if (!block) return;
        turn.pending.delete(ev.id);
        const result: ToolResultBlock = { type: "tool_result", tool_use_id: ev.id, content: ev.content, ...(ev.isError ? { is_error: true } : {}) };
        turn.handlers.onToolResult?.(block, result);
        turn.trace.push(toTraceEntry(block, result));
        turn.segments.push(turn.current);
        turn.current = "";
        return;
      }
      case "result": {
        if (ev.usage) turn.handlers.onUsage?.(ev.usage);
        const text = this.text(turn);
        // The CLI reports API failures as subtype "success" with is_error set; the message rides in result.
        if (ev.isError) {
          turn.settle({ text, trace: turn.trace, error: new Error(ev.text || ev.subtype) });
        } else if (ev.subtype === "success") {
          turn.settle({ text, trace: turn.trace });
        } else if (ev.subtype === "error_max_turns") {
          turn.handlers.onNotice?.("Stopped after the tool iteration cap — ask me to continue if the answer is incomplete.");
          turn.settle({ text, trace: turn.trace, capped: true });
        } else {
          turn.settle({ text, trace: turn.trace, error: new Error(ev.text || ev.subtype) });
        }
        return;
      }
    }
  }

  private clearShutdownTimers(): void {
    for (const timer of this.shutdownTimers) window.clearTimeout(timer);
    this.shutdownTimers = [];
  }

  private clearIdleTimers(): void {
    if (this.idleNoticeTimer !== null) window.clearTimeout(this.idleNoticeTimer);
    if (this.idleAbortTimer !== null) window.clearTimeout(this.idleAbortTimer);
    this.idleNoticeTimer = null;
    this.idleAbortTimer = null;
  }

  /** (Re)arms the idle watchdog from now; paused (no timers) whenever a tool result is pending. */
  private armIdleWatchdog(): void {
    this.clearIdleTimers();
    const turn = this.active;
    if (!turn || turn.pending.size > 0) return;
    const noticeMs = this.deps.idleNoticeMs ?? IDLE_NOTICE_MS;
    const abortMs = this.deps.idleAbortMs ?? IDLE_ABORT_MS;
    const label = this.deps.backend.label;
    this.idleNoticeTimer = window.setTimeout(() => {
      turn.handlers.onNotice?.(`${label} has been silent for ${Math.round(noticeMs / 1000)}s — still waiting. Stop to cancel.`);
    }, noticeMs);
    this.idleAbortTimer = window.setTimeout(() => {
      turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(`${label} produced no output for ${Math.round(abortMs / 60_000)} minutes, so the session was stopped. Send again to start a new one.`) });
      this.interrupt();
    }, abortMs);
  }
}

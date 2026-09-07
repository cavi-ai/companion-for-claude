// One Claude Code process per conversation; the CLI runs the tools, this class renders the turn. Pure: the spawn is injected.

import type { AgentTurnHandlers, AgentTurnResult, AgentTurnRunner } from "../agent/loop";
import { toTraceEntry } from "../agent/loop";
import type { CompletionRequest, ContentBlock, ToolResultBlock, ToolUseBlock } from "../providers/types";
import type { ToolTraceEntry } from "../types";
import { StreamJsonParser, type CliEvent } from "./streamJson";

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

export interface CliSessionDeps {
  spawn: CliSpawn;
  /** Prepended to the first user message of a fresh process. */
  transcript?: string;
}

const STDERR_TAIL = 500;
const CLOSE_GRACE_MS = 3000;

/** The stream-json line for the request's last user message (text, image, document blocks). */
export function userMessageLine(req: CompletionRequest, transcript: string | null): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const blocks: ContentBlock[] = last === undefined ? [] : typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.filter((b) => b.type === "text" || b.type === "image" || b.type === "document");
  const content = transcript ? [{ type: "text", text: transcript } as ContentBlock, ...blocks] : blocks;
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

interface ActiveTurn {
  handlers: AgentTurnHandlers;
  settle: (result: AgentTurnResult) => void;
  segments: string[];
  current: string;
  trace: ToolTraceEntry[];
  pending: Map<string, ToolUseBlock>;
}

export class ClaudeCliSession implements AgentTurnRunner {
  private child: CliChild | null = null;
  private parser = new StreamJsonParser();
  private stderrTail = "";
  private id: string | null = null;
  private active: ActiveTurn | null = null;
  private closed = false;
  private firstMessage = true;
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly deps: CliSessionDeps) {}

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
    if (this.closed) return Promise.reject(new Error("This Claude Code session is closed."));
    if (this.active) return Promise.reject(new Error("A turn is already running in this conversation."));
    if (!this.child) this.child = this.attach(this.deps.spawn());
    const child = this.child;
    return new Promise<AgentTurnResult>((resolve) => {
      const turn: ActiveTurn = { handlers, settle: (r) => this.finish(turn, r, resolve), segments: [], current: "", trace: [], pending: new Map() };
      this.active = turn;
      const line = userMessageLine(req, this.firstMessage ? this.deps.transcript ?? null : null);
      this.firstMessage = false;
      child.stdin.write(line, (err) => {
        if (err) turn.settle({ text: "", trace: [], error: new Error(`Could not write to Claude Code: ${err.message}`) });
      });
    });
  }

  interrupt(): void {
    const child = this.child;
    if (!child) return;
    // SIGINT ends the Claude Code process, and its --session-id cannot be reused; the next turn gets a new session.
    this.closed = true;
    child.kill("SIGINT");
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
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
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL);
    });
    child.on("error", (err) => this.onExit(`Claude Code failed to start: ${err.message}`));
    child.on("exit", (code) => this.onExit(`Claude Code exited (code ${code ?? "?"}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim()}` : ""}`));
    return child;
  }

  private onExit(message: string): void {
    this.closed = true; // a process that died for any reason ends the session
    if (this.child) this.child = null;
    for (const w of this.exitWaiters.splice(0)) w();
    const turn = this.active;
    if (turn) turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(message) });
  }

  private text(turn: ActiveTurn): string {
    return [...turn.segments, turn.current].filter((s) => s.trim().length > 0).join("\n\n");
  }

  private finish(turn: ActiveTurn, result: AgentTurnResult, resolve: (r: AgentTurnResult) => void): void {
    if (this.active !== turn) return;
    this.active = null;
    resolve(result);
  }

  private onEvent(ev: CliEvent): void {
    const turn = this.active;
    if (ev.kind === "init") {
      this.id = ev.sessionId;
      const down = ev.mcp.find((m) => m.status !== "connected");
      if (down && turn) {
        this.interrupt();
        turn.settle({ text: this.text(turn), trace: turn.trace, error: new Error(`MCP bridge not connected (${down.name}: ${down.status})`) });
      }
      return;
    }
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
}

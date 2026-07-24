// The agent turn: stream → execute tool calls → feed results back → re-stream,
// until the model stops asking for tools or the iteration cap is hit. Pure
// orchestration — the provider stream and tool executor are injected, so the
// whole loop unit-tests with fakes (no Obsidian, no network).

import type { StreamHandlers, ToolTraceEntry } from "../types";
import type { ApiMessage, CompletionRequest, ContentBlock, ToolResultBlock, ToolUseBlock } from "../providers/types";

export interface AgentTurnDeps {
  /** Provider streaming call (AnthropicProvider.stream). */
  stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void>;
  /** Executes one tool call (agent/tools.executeTool, wired to VaultTools). */
  execute(block: ToolUseBlock): Promise<ToolResultBlock>;
  /** Loop cap (settings.agentMaxIterations). */
  maxIterations: number;
  signal?: AbortSignal;
}

export interface AgentTurnHandlers {
  onText(delta: string): void;
  onThinking?(delta: string): void;
  onUsage?: StreamHandlers["onUsage"];
  onTruncated?(): void;
  /** A tool call is about to run (render its chip). */
  onToolStart?(block: ToolUseBlock): void;
  /** A tool call finished (update the chip with its result). */
  onToolResult?(block: ToolUseBlock, result: ToolResultBlock): void;
  /** A user-facing notice line (e.g. iteration cap reached). */
  onNotice?(text: string): void;
}

export interface AgentTurnResult {
  /** All visible text across iterations, joined for the final render/persist. */
  text: string;
  /** Display record of every tool call, for chips + conversation replay. */
  trace: ToolTraceEntry[];
  aborted?: boolean;
  capped?: boolean;
  error?: Error;
}

const ARGS_SUMMARY_MAX = 120;
const RESULT_PREVIEW_MAX = 400;

export async function runAgentTurn(deps: AgentTurnDeps, req: CompletionRequest, handlers: AgentTurnHandlers): Promise<AgentTurnResult> {
  const messages: ApiMessage[] = [...req.messages];
  const trace: ToolTraceEntry[] = [];
  const segments: string[] = [];
  const joined = () => segments.filter((s) => s.trim().length > 0).join("\n\n");

  for (let iteration = 0; iteration < deps.maxIterations; iteration++) {
    if (deps.signal?.aborted) return { text: joined(), trace, aborted: true };

    // One streaming pass; collect what the model produced.
    let text = "";
    let stopReason: string | undefined;
    let error: Error | undefined;
    const toolUses: ToolUseBlock[] = [];
    await deps.stream(
      { ...req, messages },
      {
        onText: (delta) => {
          text += delta;
          handlers.onText(delta);
        },
        ...(handlers.onThinking ? { onThinking: (d: string) => handlers.onThinking?.(d) } : {}),
        ...(handlers.onUsage ? { onUsage: (u: Parameters<NonNullable<StreamHandlers["onUsage"]>>[0]) => handlers.onUsage?.(u) } : {}),
        ...(handlers.onTruncated ? { onTruncated: () => handlers.onTruncated?.() } : {}),
        onToolUse: (block) => toolUses.push(block),
        onStopReason: (reason) => (stopReason = reason),
        onError: (err) => (error = err),
      },
    );
    segments.push(text);
    if (error) return { text: joined(), trace, error };
    if (stopReason !== "tool_use" || toolUses.length === 0) return { text: joined(), trace };

    // Execute the requested tools in arrival order and build the next exchange.
    const results: ToolResultBlock[] = [];
    for (const block of toolUses) {
      if (deps.signal?.aborted) return { text: joined(), trace, aborted: true };
      handlers.onToolStart?.(block);
      const result = await deps.execute(block);
      handlers.onToolResult?.(block, result);
      trace.push(toTraceEntry(block, result));
      results.push(result);
    }
    if (deps.signal?.aborted) return { text: joined(), trace, aborted: true };

    const assistantBlocks: ContentBlock[] = [
      ...(text.trim().length > 0 ? [{ type: "text", text } as ContentBlock] : []),
      // Strip local-only fields (parseError) — the API rejects unknown keys.
      ...toolUses.map(({ type, id, name, input }) => ({ type, id, name, input })),
    ];
    messages.push({ role: "assistant", content: assistantBlocks });
    messages.push({ role: "user", content: results });
  }

  handlers.onNotice?.(`Stopped after ${deps.maxIterations} tool iterations — ask me to continue if the answer is incomplete.`);
  return { text: joined(), trace, capped: true };
}

function toTraceEntry(block: ToolUseBlock, result: ToolResultBlock): ToolTraceEntry {
  const args = JSON.stringify(block.input);
  return {
    name: block.name,
    argsSummary: args.length > ARGS_SUMMARY_MAX ? `${args.slice(0, ARGS_SUMMARY_MAX)}…` : args,
    resultPreview: result.content.length > RESULT_PREVIEW_MAX ? `${result.content.slice(0, RESULT_PREVIEW_MAX)}…` : result.content,
    ok: !result.is_error,
  };
}

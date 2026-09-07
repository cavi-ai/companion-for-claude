// Pure NDJSON parser for the CLI's stream-json print mode. Text comes only from deltas; assistant messages contribute tool_use only.

import type { TokenUsage } from "../claude/sse";
import type { ToolUseBlock } from "../providers/types";

export type CliEvent =
  | { kind: "init"; sessionId: string; model: string; tools: string[]; mcp: { name: string; status: string }[] }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolUse"; block: ToolUseBlock }
  | { kind: "toolResult"; id: string; content: string; isError: boolean }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "retry"; attempt: number; error: string }
  | { kind: "result"; subtype: string; text: string; sessionId: string; usage?: TokenUsage; costUsd?: number; stopReason?: string; isError: boolean };

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

function usageOf(v: unknown): TokenUsage | undefined {
  const u = obj(v);
  if (Object.keys(u).length === 0) return undefined;
  const out: TokenUsage = {};
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const n = num(u[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function resultContent(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => str(obj(b).text)).filter((t) => t.length > 0).join("\n");
  return "";
}

export function parseCliLine(line: string): CliEvent[] {
  let o: Json;
  try {
    o = obj(JSON.parse(line));
  } catch {
    return [];
  }
  switch (o.type) {
    case "system": {
      if (o.subtype === "init") {
        const mcp = Array.isArray(o.mcp_servers) ? o.mcp_servers.map((s) => ({ name: str(obj(s).name), status: str(obj(s).status) })) : [];
        const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [];
        return [{ kind: "init", sessionId: str(o.session_id), model: str(o.model), tools, mcp }];
      }
      if (o.subtype === "api_retry") return [{ kind: "retry", attempt: num(o.attempt) ?? 0, error: str(o.error, "unknown") }];
      return [];
    }
    case "stream_event": {
      const ev = obj(o.event);
      if (ev.type === "content_block_delta") {
        const d = obj(ev.delta);
        if (d.type === "text_delta") return [{ kind: "text", delta: str(d.text) }];
        if (d.type === "thinking_delta") return [{ kind: "thinking", delta: str(d.thinking) }];
        return [];
      }
      if (ev.type === "message_delta") {
        const usage = usageOf(ev.usage);
        return usage ? [{ kind: "usage", usage }] : [];
      }
      return [];
    }
    case "assistant": {
      const content = obj(o.message).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((b): CliEvent[] => {
        const block = obj(b);
        if (block.type !== "tool_use") return [];
        return [{ kind: "toolUse", block: { type: "tool_use", id: str(block.id), name: str(block.name), input: obj(block.input) } }];
      });
    }
    case "user": {
      const content = obj(o.message).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((b): CliEvent[] => {
        const block = obj(b);
        if (block.type !== "tool_result") return [];
        return [{ kind: "toolResult", id: str(block.tool_use_id), content: resultContent(block.content), isError: block.is_error === true }];
      });
    }
    case "result": {
      const usage = usageOf(o.usage);
      const cost = num(o.total_cost_usd);
      const stop = str(o.stop_reason);
      return [{
        kind: "result",
        subtype: str(o.subtype, "unknown"),
        text: resultContent(o.result),
        sessionId: str(o.session_id),
        isError: o.is_error === true,
        ...(usage ? { usage } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(stop ? { stopReason: stop } : {}),
      }];
    }
    default:
      return [];
  }
}

export class StreamJsonParser {
  private buffer = "";

  push(chunk: string): CliEvent[] {
    this.buffer += chunk;
    const out: CliEvent[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) out.push(...parseCliLine(line));
    }
    return out;
  }

  flush(): CliEvent[] {
    const line = this.buffer.trim();
    this.buffer = "";
    return line ? parseCliLine(line) : [];
  }
}

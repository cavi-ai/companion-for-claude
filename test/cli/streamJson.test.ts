import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StreamJsonParser, parseCliLine, type CliEvent } from "../../src/cli/streamJson";

const fixture = (name: string): string => readFileSync(join(__dirname, "..", "fixtures", "cli", name), "utf8");
const kinds = (events: CliEvent[]): string[] => events.map((e) => e.kind);

describe("parseCliLine", () => {
  it("maps system/init to an init event with tools and mcp status", () => {
    const [ev] = parseCliLine('{"type":"system","subtype":"init","session_id":"s1","model":"m","tools":["mcp__obsidian-vault__vault_search"],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}');
    expect(ev).toEqual({ kind: "init", sessionId: "s1", model: "m", tools: ["mcp__obsidian-vault__vault_search"], mcp: [{ name: "obsidian-vault", status: "connected" }] });
  });
  it("maps text and thinking deltas, ignores signature deltas", () => {
    expect(parseCliLine('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}}')).toEqual([{ kind: "text", delta: "ok" }]);
    expect(parseCliLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}')).toEqual([{ kind: "thinking", delta: "hm" }]);
    expect(parseCliLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"x"}}}')).toEqual([]);
  });
  it("takes tool_use from assistant messages and tool_result from user messages, never assistant text", () => {
    expect(parseCliLine('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"dup"},{"type":"tool_use","id":"t1","name":"mcp__obsidian-vault__note_create","input":{"title":"S"}}]}}'))
      .toEqual([{ kind: "toolUse", block: { type: "tool_use", id: "t1", name: "mcp__obsidian-vault__note_create", input: { title: "S" } } }]);
    expect(parseCliLine('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"User declined (spike)","is_error":true}]}}'))
      .toEqual([{ kind: "toolResult", id: "t1", content: "User declined (spike)", isError: true }]);
    expect(parseCliLine('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]}}'))
      .toEqual([{ kind: "toolResult", id: "t2", content: "a\nb", isError: false }]);
  });
  it("maps message_delta usage, api_retry, and result", () => {
    expect(parseCliLine('{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":2}}}')).toEqual([{ kind: "usage", usage: { input_tokens: 10, output_tokens: 2 } }]);
    expect(parseCliLine('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"error":"overloaded"}')).toEqual([{ kind: "retry", attempt: 2, error: "overloaded" }]);
    expect(parseCliLine('{"type":"result","subtype":"success","result":"ok","session_id":"s1","total_cost_usd":0.05,"is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":92,"cache_read_input_tokens":0,"cache_creation_input_tokens":24890}}'))
      .toEqual([{ kind: "result", subtype: "success", text: "ok", sessionId: "s1", costUsd: 0.05, isError: false, stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 92, cache_read_input_tokens: 0, cache_creation_input_tokens: 24890 } }]);
  });
  it("drops malformed lines and unknown types", () => {
    expect(parseCliLine("not json")).toEqual([]);
    expect(parseCliLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseCliLine('{"type":"system","subtype":"thinking_tokens"}')).toEqual([]);
  });
});

describe("StreamJsonParser", () => {
  it("reassembles lines split across chunks", () => {
    const p = new StreamJsonParser();
    const first = p.push('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_de');
    expect(first).toEqual([]);
    const second = p.push('lta","text":"ok"}}}\n{"type":"result","subtype":"success","result":"ok","session_id":"s","is_error":false}\n');
    expect(kinds(second)).toEqual(["text", "result"]);
    expect(p.flush()).toEqual([]);
  });
  it("replays the text-turn fixture: text only from deltas, one result", () => {
    const events = new StreamJsonParser().push(fixture("text-turn.jsonl"));
    expect(kinds(events).filter((k) => k === "init")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("ok");
    expect(events.filter((e) => e.kind === "thinking").length).toBeGreaterThan(0);
    const result = events.find((e) => e.kind === "result") as Extract<CliEvent, { kind: "result" }>;
    expect(result.text).toBe("ok");
    expect(result.usage?.output_tokens).toBe(92);
  });
  it("replays the tool-deny fixture: tool_use, error tool_result, DENIED text", () => {
    const events = new StreamJsonParser().push(fixture("tool-deny-turn.jsonl"));
    const use = events.find((e) => e.kind === "toolUse") as Extract<CliEvent, { kind: "toolUse" }>;
    expect(use.block.name).toBe("mcp__obsidian-vault__note_create");
    const res = events.find((e) => e.kind === "toolResult") as Extract<CliEvent, { kind: "toolResult" }>;
    expect(res.isError).toBe(true);
    // Probe 4 ran without --include-partial-messages, so this fixture carries no text deltas; the text lives only in result.
    expect(events.filter((e) => e.kind === "text")).toEqual([]);
    const result = events.find((e) => e.kind === "result") as Extract<CliEvent, { kind: "result" }>;
    expect(result.text).toBe("DENIED");
  });
});

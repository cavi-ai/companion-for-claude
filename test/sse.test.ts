import { describe, it, expect } from "vitest";
import { parseSseChunk, extractApiError } from "../src/claude/sse";

const delta = (text: string) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n`;

describe("parseSseChunk", () => {
  it("extracts text from content_block_delta events", () => {
    const r = parseSseChunk(delta("Hello ") + delta("world"));
    expect(r.text).toBe("Hello world");
    expect(r.remainder).toBe("");
    expect(r.error).toBeUndefined();
  });

  it("ignores non-text events and keep-alives", () => {
    const buf = `event: ping\n` + `data: {"type":"message_start"}\n` + `: comment\n` + delta("hi");
    const r = parseSseChunk(buf);
    expect(r.text).toBe("hi");
  });

  it("returns an incomplete trailing line as remainder", () => {
    const buf = delta("done") + `data: {"type":"content_block_delta","delta":{"type":"text_de`;
    const r = parseSseChunk(buf);
    expect(r.text).toBe("done");
    expect(r.remainder.startsWith("data:")).toBe(true);
    // feeding the remainder + rest yields the held-back delta
    const r2 = parseSseChunk(r.remainder + `lta","text":"!"}}\n`);
    expect(r2.text).toBe("!");
  });

  it("skips [DONE] and blank data lines", () => {
    const r = parseSseChunk(delta("x") + `data: [DONE]\n` + `data:\n`);
    expect(r.text).toBe("x");
  });

  it("surfaces error events", () => {
    const r = parseSseChunk(`data: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n`);
    expect(r.error).toBe("overloaded");
  });

  it("ignores malformed JSON without throwing", () => {
    const r = parseSseChunk(`data: {not json\n` + delta("ok"));
    expect(r.text).toBe("ok");
  });
});

describe("extractApiError", () => {
  it("uses the structured message when present", () => {
    expect(extractApiError(JSON.stringify({ error: { message: "bad model" } }), 400)).toBe("Anthropic API 400: bad model");
  });
  it("has friendly fallbacks for common statuses", () => {
    expect(extractApiError("", 401)).toMatch(/invalid API key/);
    expect(extractApiError("", 429)).toMatch(/rate limited/);
    expect(extractApiError("<html>502</html>", 502)).toBe("Anthropic API error 502.");
  });
});

describe("parseSseChunk stop_reason", () => {
  it("surfaces a max_tokens truncation from message_delta", () => {
    const evt = `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } })}\n`;
    const r = parseSseChunk(delta("partial…") + evt);
    expect(r.text).toBe("partial…");
    expect(r.stopReason).toBe("max_tokens");
  });
  it("leaves stopReason undefined on a normal end_turn", () => {
    const evt = `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n`;
    expect(parseSseChunk(evt).stopReason).toBe("end_turn");
    expect(parseSseChunk(delta("hi")).stopReason).toBeUndefined();
  });
});

// ----- tool_use block streaming (agent mode) -----

const toolStart = (index: number, id: string, name: string) =>
  `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } })}\n`;
const toolJson = (index: number, partial_json: string) =>
  `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })}\n`;
const blockStop = (index: number) => `data: ${JSON.stringify({ type: "content_block_stop", index })}\n`;

describe("parseSseChunk tool_use blocks", () => {
  it("assembles a complete tool_use block", () => {
    const buf = toolStart(1, "toolu_1", "vault_search") + toolJson(1, '{"query"') + toolJson(1, ':"grief"}') + blockStop(1);
    const r = parseSseChunk(buf);
    expect(r.toolUses).toEqual([{ type: "tool_use", id: "toolu_1", name: "vault_search", input: { query: "grief" } }]);
  });

  it("threads open blocks across chunk boundaries via state", () => {
    const r1 = parseSseChunk(toolStart(1, "toolu_1", "note_read") + toolJson(1, '{"pa'));
    expect(r1.toolUses).toEqual([]);
    const r2 = parseSseChunk(toolJson(1, 'th":"A.md"}') + blockStop(1), r1.state);
    expect(r2.toolUses).toEqual([{ type: "tool_use", id: "toolu_1", name: "note_read", input: { path: "A.md" } }]);
  });

  it("handles parallel tool blocks at different indices", () => {
    const buf =
      toolStart(1, "toolu_a", "vault_search") +
      toolStart(2, "toolu_b", "list_recent") +
      toolJson(1, '{"query":"x"}') +
      toolJson(2, '{"limit":5}') +
      blockStop(2) +
      blockStop(1);
    const r = parseSseChunk(buf);
    expect(r.toolUses.map((t) => t.id)).toEqual(["toolu_b", "toolu_a"]); // completion order
    expect(r.toolUses.find((t) => t.id === "toolu_a")?.input).toEqual({ query: "x" });
    expect(r.toolUses.find((t) => t.id === "toolu_b")?.input).toEqual({ limit: 5 });
  });

  it("yields empty input when no json deltas arrive", () => {
    const r = parseSseChunk(toolStart(1, "toolu_1", "vault_tags") + blockStop(1));
    expect(r.toolUses).toEqual([{ type: "tool_use", id: "toolu_1", name: "vault_tags", input: {} }]);
  });

  it("flags malformed input JSON with parseError instead of throwing", () => {
    const r = parseSseChunk(toolStart(1, "toolu_1", "note_read") + toolJson(1, '{"path": nope') + blockStop(1));
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0].input).toEqual({});
    expect(r.toolUses[0].parseError).toBeTruthy();
  });

  it("interleaves text deltas and tool blocks", () => {
    const buf = delta("Let me search. ") + toolStart(1, "toolu_1", "vault_search") + toolJson(1, "{}") + blockStop(1) + delta("Searching…");
    const r = parseSseChunk(buf);
    expect(r.text).toBe("Let me search. Searching…");
    expect(r.toolUses).toHaveLength(1);
  });

  it("ignores content_block_stop for non-tool blocks", () => {
    const textStart = `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`;
    const r = parseSseChunk(textStart + delta("hi") + blockStop(0));
    expect(r.text).toBe("hi");
    expect(r.toolUses).toEqual([]);
  });

  it("surfaces stop_reason tool_use", () => {
    const evt = `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } })}\n`;
    expect(parseSseChunk(evt).stopReason).toBe("tool_use");
  });
});

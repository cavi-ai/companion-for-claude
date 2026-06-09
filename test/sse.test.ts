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

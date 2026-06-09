import { describe, it, expect } from "vitest";
import { parseOllamaLine } from "../src/providers/ollamaParse";
import { errorHint } from "../src/providers/errorHints";
import { parseTaggerOutput } from "../src/indexing/taggerParse";

describe("parseOllamaLine", () => {
  it("extracts streamed content", () => {
    const r = parseOllamaLine('{"message":{"role":"assistant","content":"Hel"},"done":false}');
    expect(r.text).toBe("Hel");
    expect(r.done).toBe(false);
  });
  it("flags the terminal done line", () => {
    const r = parseOllamaLine('{"done":true,"total_duration":123}');
    expect(r.done).toBe(true);
    expect(r.text).toBe("");
  });
  it("ignores blank and malformed lines", () => {
    expect(parseOllamaLine("")).toEqual({ text: "", done: false });
    expect(parseOllamaLine("{partial")).toEqual({ text: "", done: false });
  });
  it("surfaces an error field", () => {
    const r = parseOllamaLine('{"error":"model not found"}');
    expect(r.error).toBe("model not found");
    expect(r.done).toBe(true);
  });
});

describe("errorHint", () => {
  it("maps auth errors to a key hint", () => {
    expect(errorHint("Anthropic API 401: invalid API key.")).toMatch(/API key/i);
  });
  it("maps model errors", () => {
    expect(errorHint("model: not_found")).toMatch(/model id/i);
  });
  it("maps ollama/connection errors", () => {
    expect(errorHint("Ollama error 0 at http://localhost:11434")).toMatch(/ollama serve/i);
    expect(errorHint("fetch failed")).toMatch(/local model/i);
  });
  it("returns null when there is no specific hint", () => {
    expect(errorHint("some unknown teapot error")).toBeNull();
  });
});

describe("parseTaggerOutput", () => {
  it("parses the two-line TAGS/SUMMARY format", () => {
    const out = parseTaggerOutput("TAGS: machine-learning, data, pipeline\nSUMMARY: A note about ML pipelines.");
    expect(out.tags).toEqual(["machine-learning", "data", "pipeline"]);
    expect(out.summary).toBe("A note about ML pipelines.");
  });
  it("is case-insensitive and tolerant of extra prose", () => {
    const out = parseTaggerOutput("Sure!\ntags: alpha, beta\nsummary: Two greek letters.");
    expect(out.tags).toEqual(["alpha", "beta"]);
    expect(out.summary).toBe("Two greek letters.");
  });
  it("falls back to treating the whole text as tags when unformatted", () => {
    const out = parseTaggerOutput("alpha beta gamma");
    expect(out.tags).toEqual(["alpha", "beta", "gamma"]);
    expect(out.summary).toBe("");
  });
});

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
  it("suggests checking the API key on 401", () => {
    expect(errorHint("Anthropic API 401: invalid API key.")).toMatch(/API key/i);
  });
  it("suggests the model dropdown on not_found", () => {
    expect(errorHint("model: not_found")).toMatch(/model id/i);
  });
  it("suggests ollama serve only for the ollama provider", () => {
    expect(errorHint("Ollama error 0 at http://localhost:11434", "ollama")).toMatch(/ollama serve/i);
    expect(errorHint("fetch failed", "ollama")).toMatch(/local model/i);
  });
  it("treats network failures on the anthropic provider as offline, not ollama", () => {
    expect(errorHint("fetch failed")).toMatch(/offline/i);
    expect(errorHint("fetch failed", "anthropic")).toMatch(/offline/i);
    expect(errorHint("fetch failed", "anthropic")).not.toMatch(/ollama/i);
  });
  it("recognizes 529 overloaded before the generic model check", () => {
    expect(errorHint("Anthropic API 529: overloaded_error")).toMatch(/overloaded/i);
    expect(errorHint("Anthropic API 529: overloaded_error")).not.toMatch(/model id/i);
    expect(errorHint("model overloaded (529)")).toMatch(/overloaded/i);
    expect(errorHint("model overloaded (529)")).not.toMatch(/model id/i);
  });
  it("mentions rate limits on 429", () => {
    expect(errorHint("HTTP 429 rate_limit_error")).toMatch(/rate/i);
    expect(errorHint("rate limit exceeded")).toMatch(/rate/i);
    expect(errorHint("Too Many Requests")).toMatch(/rate/i);
  });
  it("does not misread 'rate' inside unrelated words as a rate limit", () => {
    expect(errorHint("could not separate the response")).toBeNull();
  });
  it("recognizes the Chromium 'Failed to fetch' offline message", () => {
    expect(errorHint("Failed to fetch")).toMatch(/offline/i);
    expect(errorHint("Failed to fetch", "ollama")).toMatch(/local model/i);
  });
  it("returns null for unknown errors", () => {
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

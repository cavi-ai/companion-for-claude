import { describe, it, expect } from "vitest";
import { parseOllamaLine } from "../src/providers/ollamaParse";
import { buildOllamaRequestBody } from "../src/providers/ollamaBody";
import { errorHint } from "../src/providers/errorHints";
import { parseTaggerOutput } from "../src/indexing/taggerParse";
import { migrateSystemPrompt, DEFAULT_SETTINGS } from "../src/types";
import type { CompletionRequest } from "../src/providers/types";

describe("migrateSystemPrompt", () => {
  it("upgrades only the exact legacy default, never a customized prompt", () => {
    const legacy =
      "You are Claude, working inside the user's Obsidian vault. Be concise and precise. " +
      "When the user asks for a plan, report, diagram, or anything visual, prefer producing a single " +
      "self-contained HTML artifact in a ```claude-html code block using the provided design system.";
    expect(migrateSystemPrompt(legacy)).toBe(DEFAULT_SETTINGS.systemPrompt);
    expect(migrateSystemPrompt(`${legacy} Extra user sentence.`)).toBeUndefined();
    expect(migrateSystemPrompt(DEFAULT_SETTINGS.systemPrompt)).toBeUndefined();
    expect(migrateSystemPrompt(undefined)).toBeUndefined();
  });
});

const baseReq: CompletionRequest = {
  system: "Extract JSON.",
  messages: [{ role: "user", content: "content" }],
  model: "qwen3.6:latest",
  maxTokens: 4096,
  temperature: 0,
};

describe("buildOllamaRequestBody", () => {
  it("sends think:false when thinking is disabled — thinking models otherwise reply empty", () => {
    const body = JSON.parse(buildOllamaRequestBody({ ...baseReq, thinking: { type: "disabled" } }, "default"));
    expect(body.think).toBe(false);
    expect(body.options.num_predict).toBe(4096);
  });

  it("omits think for ordinary requests and maps JSON mode to format", () => {
    const plain = JSON.parse(buildOllamaRequestBody(baseReq, "default"));
    expect(plain).not.toHaveProperty("think");
    expect(plain).not.toHaveProperty("format");
    const json = JSON.parse(buildOllamaRequestBody({ ...baseReq, responseFormat: "json", responseSchema: { type: "object" } }, "default"));
    expect(json.format).toEqual({ type: "object" });
    const jsonMode = JSON.parse(buildOllamaRequestBody({ ...baseReq, responseFormat: "json" }, "default"));
    expect(jsonMode.format).toBe("json");
  });

  it("maps tool defs to Ollama's function shape", () => {
    const body = JSON.parse(
      buildOllamaRequestBody(
        { ...baseReq, tools: [{ name: "vault_search", description: "Search notes.", input_schema: { type: "object", properties: { query: { type: "string" } } } }] },
        "default",
      ),
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "vault_search", description: "Search notes.", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    ]);
    expect(JSON.parse(buildOllamaRequestBody(baseReq, "default"))).not.toHaveProperty("tools");
  });

  it("translates tool_use / tool_result history into Ollama's tool messages", () => {
    const body = JSON.parse(
      buildOllamaRequestBody(
        {
          ...baseReq,
          messages: [
            { role: "user", content: "search my notes" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Let me look." },
                { type: "tool_use", id: "ollama-tc-0", name: "vault_search", input: { query: "cats" } },
              ],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "ollama-tc-0", content: "3 hits about cats" }] },
          ],
        },
        "default",
      ),
    );
    const [system, user, assistant, tool] = body.messages;
    expect(system.role).toBe("system");
    expect(user).toEqual({ role: "user", content: "search my notes" });
    expect(assistant).toEqual({
      role: "assistant",
      content: "Let me look.",
      tool_calls: [{ function: { name: "vault_search", arguments: { query: "cats" } } }],
    });
    expect(tool).toEqual({ role: "tool", content: "3 hits about cats" });
  });
});

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
  it("extracts tool calls and coerces malformed arguments to {}", () => {
    const r = parseOllamaLine(
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"vault_search","arguments":{"query":"cats"}}},{"function":{"name":"bad","arguments":[1]}},{}]},"done":true}',
    );
    expect(r.toolCalls).toEqual([
      { name: "vault_search", input: { query: "cats" } },
      { name: "bad", input: {} },
    ]);
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
  it("names the configured Ollama endpoint in a network hint", () => {
    expect(errorHint("fetch failed", "ollama", "http://192.168.1.24:11434")).toContain("Ollama at http://192.168.1.24:11434");
  });
  it("attributes authentication failures to the configured OpenAI-compatible endpoint", () => {
    const hint = errorHint("Endpoint error 401", "openai-compat", "https://models.example.com/v1");
    expect(hint).toContain("OpenAI-compatible endpoint at https://models.example.com/v1");
    expect(hint).not.toMatch(/Anthropic API key/i);
  });
  it("names the configured OpenAI-compatible endpoint in a network hint", () => {
    expect(errorHint("failed to fetch", "openai-compat", "http://192.168.1.24:1234")).toContain(
      "OpenAI-compatible endpoint at http://192.168.1.24:1234",
    );
  });
  it("treats network failures on the anthropic provider as offline, not ollama", () => {
    expect(errorHint("fetch failed")).toMatch(/offline/i);
    expect(errorHint("fetch failed", "anthropic")).toMatch(/offline/i);
    expect(errorHint("fetch failed", "anthropic")).not.toMatch(/ollama/i);
  });
  it("names a sanitized Anthropic gateway endpoint in network hints", () => {
    const hint = errorHint("fetch failed", "anthropic", "https://alice:supersecret@gateway.example.com/v1?token=private");
    expect(hint).toContain("Anthropic at https://gateway.example.com/v1");
    expect(hint).not.toMatch(/alice|supersecret|token=private/i);
  });
  it("redacts userinfo from every provider endpoint hint", () => {
    const hint = errorHint("HTTP 401 authentication failed", "openai-compat", "https://alice:supersecret@models.example.com/v1");
    expect(hint).toContain("https://models.example.com/v1");
    expect(hint).not.toMatch(/alice|supersecret/i);
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

describe("errorHint — claude-cli", () => {
  it("names the two CLI failure modes", () => {
    expect(errorHint("Claude Code not found", "claude-cli")).toMatch(/Install it/);
    expect(errorHint("Claude Code is not signed in", "claude-cli")).toMatch(/claude auth login/);
    expect(errorHint("Claude Code exited (code 1). rate limit", "claude-cli")).toMatch(/Wait a moment/);
  });
});

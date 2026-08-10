import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));
import { AnthropicProvider, buildRequestBody } from "../src/providers/anthropic";
import type { ResolvedAuth } from "../src/providers/auth";
import type { AnthropicToolDef, CompletionRequest } from "../src/providers/types";

const apiKeyAuth: ResolvedAuth = { credential: "sk-ant-api-test", scheme: "key", baseUrl: "https://api.anthropic.com", isOAuth: false };
const oauthAuth: ResolvedAuth = { credential: "sk-ant-oat-test", scheme: "bearer", baseUrl: "https://api.anthropic.com", isOAuth: true };

const tools: AnthropicToolDef[] = [
  { name: "vault_search", description: "s", input_schema: { type: "object" } },
  { name: "note_read", description: "r", input_schema: { type: "object" } },
];

const baseReq: CompletionRequest = {
  system: "Be concise.",
  messages: [{ role: "user", content: "hi" }],
  model: "claude-sonnet-4-6",
  maxTokens: 1000,
};

describe("buildRequestBody", () => {
  it("places cache_control on system, last tool, and latest user message (API key)", () => {
    const body = JSON.parse(buildRequestBody({ ...baseReq, tools }, true, apiKeyAuth));
    expect(body.system).toEqual([{ type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]).toMatchObject({ name: "note_read", cache_control: { type: "ephemeral" } });
    expect(body.messages[0].content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  it("keeps the OAuth identity as untouched block 0", () => {
    const body = JSON.parse(buildRequestBody(baseReq, true, oauthAuth));
    expect(body.system[0]).toEqual({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." });
    expect(body.system[1]).toMatchObject({ text: "Be concise.", cache_control: { type: "ephemeral" } });
  });

  it("omits the tools key when no tools are set", () => {
    const body = JSON.parse(buildRequestBody(baseReq, true, apiKeyAuth));
    expect(body).not.toHaveProperty("tools");
  });

  it("passes tool_use / tool_result block messages through", () => {
    const req: CompletionRequest = {
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hits" }] },
      ],
    };
    const body = JSON.parse(buildRequestBody(req, true, apiKeyAuth));
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "t1", input: { query: "x" } });
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", cache_control: { type: "ephemeral" } });
  });

  it("keeps supported model-aware fields (temperature/thinking) working", () => {
    const body = JSON.parse(buildRequestBody({ ...baseReq, temperature: 0.2, thinking: { type: "adaptive" }, thinkingDisplay: "summarized" }, true, apiKeyAuth));
    expect(body.temperature).toBe(0.2);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it.each([
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
  ])(
    "omits temperature for %s before sending the Anthropic request",
    (model) => {
      const body = JSON.parse(buildRequestBody({ ...baseReq, model, temperature: 0.2 }, false, apiKeyAuth));
      expect(body).not.toHaveProperty("temperature");
    },
  );
});

// ---- streaming behavior (window.fetch mocked) ----

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

const evt = (o: unknown) => `data: ${JSON.stringify(o)}\n`;

function provider(): AnthropicProvider {
  return new AnthropicProvider({ mode: "apiKey", apiKey: "sk-ant-api-test", oauthToken: "", baseUrl: "" });
}

beforeEach(() => requestUrlMock.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("AnthropicProvider auth transport consistency", () => {
  it("keeps an API key on x-api-key for both connection test and streaming chat", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, text: "", json: {} });
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      evt({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
      evt({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]));
    vi.stubGlobal("window", { fetch: fetchMock });
    const subject = new AnthropicProvider({
      mode: "apiKey",
      apiKey: "sk-ant-api-active",
      oauthToken: "sk-ant-oat-unused",
      baseUrl: "",
    });

    await subject.test();
    await subject.stream(baseReq, { onText: vi.fn() });

    const testHeaders = requestUrlMock.mock.calls[0]?.[0].headers as Record<string, string>;
    const chatHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(testHeaders["x-api-key"]).toBe("sk-ant-api-active");
    expect(chatHeaders["x-api-key"]).toBe("sk-ant-api-active");
    expect(testHeaders).not.toHaveProperty("authorization");
    expect(chatHeaders).not.toHaveProperty("authorization");
  });

  it("keeps a long-term OAuth token on the native bearer path for test and agent chat", async () => {
    requestUrlMock
      .mockResolvedValueOnce({ status: 200, text: "", json: {} })
      .mockResolvedValueOnce({
        status: 200,
        text: [
          evt({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "vault_search", input: {} } }),
          evt({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"x"}' } }),
          evt({ type: "content_block_stop", index: 0 }),
          evt({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
        ].join(""),
        json: {},
      });
    const fetchMock = vi.fn();
    vi.stubGlobal("window", { fetch: fetchMock });
    const subject = new AnthropicProvider({
      mode: "oauthToken",
      apiKey: "sk-ant-api-unused",
      oauthToken: "sk-ant-oat-active",
      baseUrl: "",
    });
    const onToolUse = vi.fn();

    await subject.test();
    await subject.stream({ ...baseReq, tools }, { onText: vi.fn(), onToolUse });

    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const [options] of requestUrlMock.mock.calls) {
      expect(options.headers.authorization).toBe("Bearer sk-ant-oat-active");
      expect(options.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(options.headers).not.toHaveProperty("x-api-key");
    }
    const testBody = JSON.parse(String(requestUrlMock.mock.calls[0]?.[0].body)) as { system: Array<{ text: string }> };
    const chatBody = JSON.parse(String(requestUrlMock.mock.calls[1]?.[0].body)) as { system: Array<{ text: string }> };
    expect(testBody.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(chatBody.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(onToolUse).toHaveBeenCalledWith({ type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } });
  });
});

describe("AnthropicProvider.stream tool use", () => {
  it("fires onToolUse and onStopReason for a tool_use turn", async () => {
    const lines = [
      evt({ type: "content_block_delta", delta: { type: "text_delta", text: "Searching. " } }),
      evt({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "vault_search", input: {} } }),
      evt({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"x"}' } }),
      evt({ type: "content_block_stop", index: 1 }),
      evt({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    ];
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(sseResponse(lines)) });
    const onToolUse = vi.fn();
    const onStopReason = vi.fn();
    const onDone = vi.fn();
    await provider().stream({ ...baseReq, tools }, { onText: vi.fn(), onToolUse, onStopReason, onDone });
    expect(onToolUse).toHaveBeenCalledWith({ type: "tool_use", id: "t1", name: "vault_search", input: { query: "x" } });
    expect(onStopReason).toHaveBeenCalledWith("tool_use");
    expect(onDone).toHaveBeenCalledWith("Searching. ");
  });

  it("suppresses the buffered fallback when tools are set", async () => {
    vi.stubGlobal("window", { fetch: vi.fn().mockRejectedValue(new Error("boom")) });
    const onError = vi.fn();
    const onDone = vi.fn();
    await provider().stream({ ...baseReq, tools }, { onText: vi.fn(), onError, onDone });
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]?.message).toBe("boom");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("AnthropicProvider.stream error handling", () => {
  it("does NOT replay a buffered fallback once text has already streamed (no duplication)", async () => {
    // Partial text arrives, THEN the stream errors. Replaying the full reply on
    // top of the partial would duplicate it in the UI, so we surface the error.
    const lines = [
      evt({ type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" } }),
      evt({ type: "error", error: { message: "mid-stream boom" } }),
    ];
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(sseResponse(lines)) });
    const onText = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    await provider().stream(baseReq, { onText, onError, onDone });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Partial answer");
    expect(onError.mock.calls[0]?.[0]?.message).toBe("mid-stream boom");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("flushes a final event that arrives without a trailing newline", async () => {
    const lines = [
      evt({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }),
      // No trailing "\n" — the stop_reason would be dropped without a final flush.
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}`,
    ];
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(sseResponse(lines)) });
    const onStopReason = vi.fn();
    const onDone = vi.fn();
    await provider().stream(baseReq, { onText: vi.fn(), onStopReason, onDone });
    expect(onStopReason).toHaveBeenCalledWith("end_turn");
    expect(onDone).toHaveBeenCalledWith("Hi");
  });
});

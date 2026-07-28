import { describe, it, expect, vi, afterEach } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

import { OpenAICompatProvider } from "../../src/providers/openaiCompat";
import type { CompletionRequest } from "../../src/providers/types";

const req: CompletionRequest = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  model: "",
  maxTokens: 100,
};

afterEach(() => {
  requestUrlMock.mockReset();
  vi.unstubAllGlobals();
});

describe("OpenAICompatProvider — base + credentials", () => {
  it("normalizes hosts with and without /v1", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "ok" } }] } });
    await new OpenAICompatProvider("http://localhost:1234/", "m", "").complete(req);
    expect(requestUrlMock.mock.calls[0]?.[0]).toMatchObject({ url: "http://localhost:1234/v1/chat/completions" });
    await new OpenAICompatProvider("http://localhost:1234/v1", "m", "").complete(req);
    expect(requestUrlMock.mock.calls[1]?.[0]).toMatchObject({ url: "http://localhost:1234/v1/chat/completions" });
  });

  it("requires a host; the key becomes a bearer header only when set", async () => {
    expect(new OpenAICompatProvider("", "m", "").hasCredentials()).toBe(false);
    expect(new OpenAICompatProvider("http://x", "m", "").hasCredentials()).toBe(true);
    requestUrlMock.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "ok" } }] } });
    await new OpenAICompatProvider("http://x", "m", "secret").complete(req);
    expect(requestUrlMock.mock.calls[0]?.[0].headers).toMatchObject({ authorization: "Bearer secret" });
    await new OpenAICompatProvider("http://x", "m", "").complete(req);
    expect(requestUrlMock.mock.calls[1]?.[0].headers).not.toHaveProperty("authorization");
  });
});

describe("OpenAICompatProvider — complete", () => {
  it("returns the first choice's content and defaults the model", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "answer" } }] } });
    const out = await new OpenAICompatProvider("http://x", "default-model", "").complete(req);
    expect(out).toBe("answer");
    const body = JSON.parse(String(requestUrlMock.mock.calls[0]?.[0].body)) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe("default-model");
    expect(body.messages[0]).toMatchObject({ role: "system", content: "sys" });
  });

  it("maps responseFormat json to response_format json_object", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "{}" } }] } });
    await new OpenAICompatProvider("http://x", "m", "").complete({ ...req, responseFormat: "json" });
    const body = JSON.parse(String(requestUrlMock.mock.calls[0]?.[0].body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws ProviderError with the status on failure", async () => {
    requestUrlMock.mockResolvedValue({ status: 500, json: {} });
    await expect(new OpenAICompatProvider("http://x", "m", "").complete(req)).rejects.toMatchObject({ status: 500 });
  });
});

describe("OpenAICompatProvider — stream", () => {
  function sseResponse(chunks: string[]): Response {
    const encoded = chunks.map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => (i < encoded.length ? Promise.resolve({ done: false, value: encoded[i++] }) : Promise.resolve({ done: true, value: undefined })),
        }),
      },
    } as unknown as Response;
  }

  it("parses SSE deltas, skips [DONE] and keepalives, reports the full text", async () => {
    const frames = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n`,
      `: keepalive\n\ndata: [DONE]\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));
    const texts: string[] = [];
    let full = "";
    await new OpenAICompatProvider("http://x", "m", "").stream(req, {
      onText: (t) => texts.push(t),
      onDone: (f) => {
        full = f;
      },
    });
    expect(texts).toEqual(["Hel", "lo"]);
    expect(full).toBe("Hello");
  });

  it("routes HTTP failures to onError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, body: null }));
    let err: Error | undefined;
    await new OpenAICompatProvider("http://x", "m", "").stream(req, {
      onText: () => {},
      onError: (e) => {
        err = e;
      },
    });
    expect(err?.message).toContain("503");
  });
});

describe("OpenAICompatProvider — embed + models", () => {
  it("returns one vector per input", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ embedding: [0.1] }, { embedding: [0.2] }] } });
    const out = await new OpenAICompatProvider("http://x", "m", "").embed("emb-model", ["a", "b"]);
    expect(out).toEqual([[0.1], [0.2]]);
    expect(requestUrlMock.mock.calls[0]?.[0]).toMatchObject({ url: "http://x/v1/embeddings" });
  });

  it("throws when the server returns fewer vectors than inputs", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ embedding: [0.1] }] } });
    await expect(new OpenAICompatProvider("http://x", "m", "").embed("e", ["a", "b"])).rejects.toThrow(/no embeddings/);
  });

  it("lists model ids for the settings dropdown", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ id: "m1" }, { id: "m2" }, {}] } });
    await expect(new OpenAICompatProvider("http://x", "m", "").listModels()).resolves.toEqual(["m1", "m2"]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

import { OllamaProvider } from "../../src/providers/ollama";
import type { CompletionRequest } from "../../src/providers/types";

const req: CompletionRequest = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  model: "llama3.1",
  maxTokens: 100,
};

/** A streaming response body that yields the given text chunks and tracks cancel(). */
function streamResponse(chunks: string[]): { res: Response; cancel: ReturnType<typeof vi.fn> } {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  const cancel = vi.fn().mockResolvedValue(undefined);
  let i = 0;
  const res = {
    ok: true,
    body: {
      getReader: () => ({
        read: () => (i < encoded.length ? Promise.resolve({ done: false, value: encoded[i++] }) : Promise.resolve({ done: true, value: undefined })),
        cancel,
      }),
    },
  } as unknown as Response;
  return { res, cancel };
}

afterEach(() => {
  requestUrlMock.mockReset();
  vi.unstubAllGlobals();
});

describe("OllamaProvider — stream", () => {
  it("parses NDJSON lines into text and cancels the reader", async () => {
    const lines = [`${JSON.stringify({ message: { content: "Hel" }, done: false })}\n`, `${JSON.stringify({ message: { content: "lo" }, done: true })}\n`];
    const { res, cancel } = streamResponse(lines);
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(res) });
    const texts: string[] = [];
    let full = "";
    await new OllamaProvider("http://localhost:11434", "llama3.1").stream(req, {
      onText: (t) => texts.push(t),
      onDone: (f) => {
        full = f;
      },
    });
    expect(texts).toEqual(["Hel", "lo"]);
    expect(full).toBe("Hello");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports final token counts via onUsage", async () => {
    const lines = [
      `${JSON.stringify({ message: { content: "hi" }, done: false })}\n`,
      `${JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 34 })}\n`,
    ];
    const { res } = streamResponse(lines);
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(res) });
    const onUsage = vi.fn();
    await new OllamaProvider("http://localhost:11434", "llama3.1").stream(req, { onText: () => {}, onUsage });
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 12, output_tokens: 34 });
  });

  it("cancels the reader when an error line aborts the stream", async () => {
    const lines = [`${JSON.stringify({ error: "model not found" })}\n`];
    const { res, cancel } = streamResponse(lines);
    vi.stubGlobal("window", { fetch: vi.fn().mockResolvedValue(res) });
    let err: Error | undefined;
    await new OllamaProvider("http://localhost:11434", "llama3.1").stream(req, {
      onText: () => {},
      onError: (e) => {
        err = e;
      },
    });
    expect(err?.message).toContain("model not found");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("OllamaProvider — capabilities cache", () => {
  it("does not cache a transient failure, so a later probe succeeds", async () => {
    vi.useFakeTimers();
    try {
      const provider = new OllamaProvider("http://localhost:11434", "llama3.1");
      requestUrlMock
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ status: 200, json: { capabilities: ["tools", "thinking"] } });

      expect(await provider.capabilities("llama3.1")).toEqual([]);
      // A failure is remembered only for the short TTL; after it, the next call retries.
      vi.advanceTimersByTime(31_000);
      expect(await provider.capabilities("llama3.1")).toEqual(["tools", "thinking"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a successful result", async () => {
    const provider = new OllamaProvider("http://localhost:11434", "llama3.1");
    requestUrlMock.mockResolvedValue({ status: 200, json: { capabilities: ["tools"] } });
    await provider.capabilities("llama3.1");
    await provider.capabilities("llama3.1");
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });
});

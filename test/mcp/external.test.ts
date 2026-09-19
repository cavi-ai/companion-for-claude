import { describe, expect, it, vi } from "vitest";
import { externalAnthropicTools, externalToolName, parseExternalToolName, sanitizeServerName } from "../../src/mcp/external";
import { createHttpMcpTransport, extractReply, parseSseMessages, type HttpResponseLike } from "../../src/mcp/httpTransport";
import type { JsonRpcRequest } from "../../src/mcp/protocol";

describe("external tool namespacing", () => {
  it("round-trips mcp__<server>__<tool>, sanitized, and rejects non-external names", () => {
    const name = externalToolName("My Server!", "read_thing");
    expect(name).toBe("mcp__My-Server__read_thing");
    expect(parseExternalToolName(name)).toEqual({ server: "My-Server", tool: "read_thing" });
    expect(parseExternalToolName("vault_search")).toBeNull();
    expect(parseExternalToolName("mcp__noversion")).toBeNull();
    expect(parseExternalToolName("mcp__s__")).toBeNull();
  });

  it("sanitizes server names to a stable, unambiguous segment", () => {
    expect(sanitizeServerName("My Server!")).toBe("My-Server");
    // `__` is the name/tool separator, so runs are collapsed to keep the split unique.
    expect(sanitizeServerName("my__server")).toBe("my_server");
    expect(sanitizeServerName("  ")).toBe("server");
    expect(parseExternalToolName(externalToolName("my__server", "tool"))).toEqual({ server: "my_server", tool: "tool" });
  });

  it("prefixes defs with the server name in name and description", () => {
    const defs = externalAnthropicTools([
      { server: "fs", tools: [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }] },
      { server: "web", tools: [{ name: "fetch", description: "Fetch.", inputSchema: { type: "object" } }] },
    ]);
    expect(defs.map((d) => d.name)).toEqual(["mcp__fs__read_file", "mcp__web__fetch"]);
    expect(defs[0]?.description).toBe("[fs] Read a file.");
  });
});

describe("parseSseMessages", () => {
  it("extracts JSON payloads from data lines, skipping non-JSON events", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\nevent: ping\ndata: not json\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"x":1}}\n\n';
    expect(parseSseMessages(body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: { x: 1 } },
    ]);
  });
});

describe("extractReply", () => {
  it("finds the matching reply in an SSE stream and ignores other ids", () => {
    const body = 'data: {"jsonrpc":"2.0","id":99,"result":{}}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(extractReply(body, "text/event-stream", 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(extractReply(body, "text/event-stream", 7)).toBeNull();
  });

  it("parses plain JSON replies and rejects garbage", () => {
    expect(extractReply('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json", 1)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(extractReply("nope", "application/json", 1)).toBeNull();
  });
});

describe("createHttpMcpTransport", () => {
  function http(respond: (req: { body: string; headers: Record<string, string> }) => HttpResponseLike) {
    const requests: { message: JsonRpcRequest; headers: Record<string, string> }[] = [];
    return {
      requests,
      do: async (req: { body: string; headers: Record<string, string> }) => {
        requests.push({ message: JSON.parse(req.body) as JsonRpcRequest, headers: req.headers });
        return respond(req);
      },
    };
  }

  it("posts JSON-RPC, echoes the session id once learned, and resolves replies", async () => {
    const { requests, do: httpDo } = http(({ body }) => {
      const message = JSON.parse(body) as JsonRpcRequest;
      return {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} }),
      };
    });
    const transport = createHttpMcpTransport("https://mcp.test/", {}, httpDo);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(requests[0]?.headers["mcp-session-id"]).toBeUndefined();
    expect(requests[1]?.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("returns null for notifications (202) and throws on HTTP errors", async () => {
    const accepted = createHttpMcpTransport("https://mcp.test/", {}, async () => ({ status: 202, headers: {}, body: "" }));
    expect(await accepted.send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    const failing = createHttpMcpTransport("https://mcp.test/", {}, async () => ({ status: 500, headers: {}, body: "" }));
    await expect(failing.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/500/);

    const noReply = createHttpMcpTransport("https://mcp.test/", {}, async () => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    await expect(noReply.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/no matching reply/i);
  });

  it("times out a request the server never answers", async () => {
    vi.useFakeTimers();
    try {
      const hung = createHttpMcpTransport("https://mcp.test/", {}, () => new Promise(() => {}));
      const pending = hung.send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
      const assertion = expect(pending).rejects.toThrow(/did not reply to tools\/call within 60s/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a notification the server never accepts", async () => {
    vi.useFakeTimers();
    try {
      const hung = createHttpMcpTransport("https://mcp.test/", {}, () => new Promise(() => {}));
      const pending = hung.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const assertion = expect(pending).rejects.toThrow(/did not reply to notifications\/initialized within 60s/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a reply that arrives after the timeout, including its session id", async () => {
    vi.useFakeTimers();
    try {
      let resolveHttp!: (r: HttpResponseLike) => void;
      const httpDo = vi.fn(() => new Promise<HttpResponseLike>((resolve) => { resolveHttp = resolve; }));
      const transport = createHttpMcpTransport("https://mcp.test/", {}, httpDo);
      const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
      const assertion = expect(pending).rejects.toThrow(/did not reply/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      resolveHttp({
        status: 200,
        headers: { "mcp-session-id": "late-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      });
      await Promise.resolve();
      await Promise.resolve();

      httpDo.mockClear();
      httpDo.mockImplementation(async () => ({ status: 202, headers: {}, body: "" }));
      await transport.send({ jsonrpc: "2.0", method: "notifications/x" });
      expect(httpDo.mock.calls[0]?.[0]?.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface a late rejection as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      let rejectHttp!: (e: Error) => void;
      const httpDo = vi.fn(() => new Promise<HttpResponseLike>((_resolve, reject) => { rejectHttp = reject; }));
      const transport = createHttpMcpTransport("https://mcp.test/", {}, httpDo);
      const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
      const assertion = expect(pending).rejects.toThrow(/did not reply/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      vi.useRealTimers();

      rejectHttp(new Error("late network failure"));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("resolves before the deadline and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const transport = createHttpMcpTransport("https://mcp.test/", {}, async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      }));
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() rejects in-flight sends and clears their timers", async () => {
    vi.useFakeTimers();
    try {
      const transport = createHttpMcpTransport("https://mcp.test/", {}, () => new Promise(() => {}));
      const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
      const assertion = expect(pending).rejects.toThrow(/connection closed/);
      await transport.close?.();
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from "vitest";
import { McpClientSession, parseCallResult, parseToolList, type McpTransport } from "../../src/mcp/client";
import type { JsonRpcRequest, JsonRpcResponse } from "../../src/mcp/protocol";

/** Scripted transport: queue of replies keyed by method. */
function scripted(handlers: Record<string, (params?: unknown) => unknown>): { transport: McpTransport; sent: JsonRpcRequest[] } {
  const sent: JsonRpcRequest[] = [];
  return {
    sent,
    transport: {
      async send(message) {
        sent.push(message);
        const handler = handlers[message.method];
        if (!handler) return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: `no such method: ${message.method}` } };
        if (message.id === undefined || message.id === null) return null;
        return { jsonrpc: "2.0", id: message.id, result: handler(message.params) };
      },
    },
  };
}

const HELLO = {
  initialize: () => ({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } }),
  "tools/list": () => ({ tools: [
    { name: "search", description: "Search things", inputSchema: { type: "object" } },
    { name: "broken" }, // no description/schema → defaults
    { notATool: true }, // skipped
  ] }),
  "tools/call": (params: unknown) => {
    const p = params as { name: string; arguments: Record<string, unknown> };
    if (p.name === "search") return { content: [{ type: "text", text: `hits for ${p.arguments.q}` }], isError: false };
    return { content: [{ type: "text", text: "kaboom" }], isError: true };
  },
};

describe("McpClientSession", () => {
  it("handshakes once, lists sanitized tools, and calls them", async () => {
    const { transport, sent } = scripted(HELLO);
    const client = new McpClientSession(transport);

    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: "search", description: "Search things", inputSchema: { type: "object" } },
      { name: "broken", description: "", inputSchema: { type: "object" } },
    ]);

    const result = await client.callTool("search", { q: "obsidian" });
    expect(result).toEqual({ text: "hits for obsidian", isError: false });

    const methods = sent.map((m) => m.method);
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1); // one handshake for both calls
    expect(methods).toContain("notifications/initialized");

    const failure = await client.callTool("explode", {});
    expect(failure).toEqual({ text: "kaboom", isError: true });
  });

  it("throws on RPC errors and malformed shapes", async () => {
    const bad = new McpClientSession(scripted({ initialize: () => ({ noVersion: true }) }).transport);
    await expect(bad.listTools()).rejects.toThrow(/malformed initialize/);

    const rpcError = new McpClientSession({
      async send(message) {
        if (message.method === "notifications/initialized") return null;
        return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: "boom" } };
      },
    });
    await expect(rpcError.listTools()).rejects.toThrow(/boom/);
  });
});

describe("parseToolList / parseCallResult", () => {
  it("rejects malformed envelopes", () => {
    expect(() => parseToolList({ tools: "nope" })).toThrow(/malformed tools\/list/);
    expect(() => parseCallResult({ noContent: true })).toThrow(/malformed tools\/call/);
  });

  it("joins multiple text blocks", () => {
    expect(parseCallResult({ content: [{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }] })).toEqual({ text: "a\nb", isError: false });
  });
});

describe("response typing", () => {
  it("accepts a well-formed reply through the JsonRpcResponse shape", () => {
    const reply: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    expect(parseToolList(reply.result)).toEqual([]);
  });
});

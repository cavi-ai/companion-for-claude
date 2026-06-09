import { describe, it, expect } from "vitest";
import { handleRpc, validateRequest, ok, err, isNotification, RPC, MCP_PROTOCOL_VERSION, type JsonRpcRequest, type McpToolDef } from "../src/mcp/protocol";

const tools: McpToolDef[] = [{ name: "vault_search", description: "search", inputSchema: { type: "object" } }];

function ctx(call?: (name: string, args: Record<string, unknown>) => Promise<string>) {
  return {
    serverInfo: { name: "obsidian-vault", version: "0.2.0" },
    tools,
    call: call ?? (async (_n: string, a: Record<string, unknown>) => `called with ${JSON.stringify(a)}`),
  };
}

describe("validateRequest", () => {
  it("rejects non-objects", () => {
    expect(validateRequest(null).error?.code).toBe(RPC.INVALID_REQUEST);
    expect(validateRequest(42).error?.code).toBe(RPC.INVALID_REQUEST);
  });
  it("rejects wrong jsonrpc version and missing method", () => {
    expect(validateRequest({ jsonrpc: "1.0", method: "x" }).error).toBeDefined();
    expect(validateRequest({ jsonrpc: "2.0" }).error).toBeDefined();
  });
  it("accepts a valid request", () => {
    const { req, error } = validateRequest({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(error).toBeUndefined();
    expect(req?.method).toBe("ping");
  });
});

describe("isNotification", () => {
  it("is true when id is absent or null", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "x" } as JsonRpcRequest)).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: null, method: "x" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
  });
});

describe("handleRpc", () => {
  it("initialize returns protocol version and serverInfo", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, ctx());
    expect(r?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "obsidian-vault" } });
  });

  it("tools/list returns the registry", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx());
    expect(r?.result).toEqual({ tools });
  });

  it("tools/call invokes the handler and wraps text content", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_search", arguments: { query: "x" } } }, ctx());
    expect(r?.result).toMatchObject({ isError: false, content: [{ type: "text", text: 'called with {"query":"x"}' }] });
  });

  it("tools/call reports a missing name as invalid params", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} }, ctx());
    expect(r?.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  it("tools/call on an unknown tool is method-not-found", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }, ctx());
    expect(r?.error?.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it("tool handler errors become isError content (not protocol errors)", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "vault_search", arguments: {} } },
      ctx(async () => {
        throw new Error("boom");
      }),
    );
    expect(r?.result).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
  });

  it("the initialized notification yields no response", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx());
    expect(r).toBeNull();
  });

  it("unknown methods are method-not-found", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 7, method: "frobnicate" }, ctx());
    expect(r?.error?.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it("ping returns an empty result", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 8, method: "ping" }, ctx());
    expect(r?.result).toEqual({});
  });
});

describe("ok/err helpers", () => {
  it("default null id when missing", () => {
    expect(ok(undefined, { a: 1 })).toEqual({ jsonrpc: "2.0", id: null, result: { a: 1 } });
    expect(err(undefined, RPC.INTERNAL_ERROR, "x").error?.code).toBe(RPC.INTERNAL_ERROR);
  });
});

import { describe, it, expect } from "vitest";
import {
  handleRpc,
  validateRequest,
  ok,
  err,
  isNotification,
  RPC,
  MCP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
  type McpToolDef,
  type ResourceProvider,
  type PromptProvider,
} from "../src/mcp/protocol";

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

describe("protocol version negotiation", () => {
  it("echoes a supported requested version and falls back to the latest otherwise", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(MCP_PROTOCOL_VERSION);
  });

  it("initialize negotiates from params.protocolVersion", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, ctx());
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("advertises resources and prompts only when providers are wired", async () => {
    const bare = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, ctx());
    expect((bare?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({ tools: { listChanged: false } });
    const full = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { ...ctx(), resources: resourcesStub(), prompts: promptsStub() });
    expect((full?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

function resourcesStub(): ResourceProvider {
  return {
    async list(cursor) {
      if (cursor === "page2") return { resources: [{ uri: "obsidian://vault/B.md", name: "B" }] };
      return { resources: [{ uri: "obsidian://vault/A.md", name: "A", mimeType: "text/markdown" }], nextCursor: "page2" };
    },
    templates: () => [{ uriTemplate: "obsidian://vault/{path}", name: "note", mimeType: "text/markdown" }],
    async read(uri) {
      return uri === "obsidian://vault/A.md" ? { uri, mimeType: "text/markdown", text: "# A" } : null;
    },
  };
}

function promptsStub(): PromptProvider {
  return {
    async list() {
      return [{ name: "daily-rollup", title: "Daily rollup", arguments: [{ name: "focus", required: false }] }];
    },
    async get(name, args) {
      if (name !== "daily-rollup") return null;
      return { description: "Rollup", messages: [{ role: "user", content: { type: "text", text: `Roll up ${args.focus ?? "everything"}` } }] };
    },
  };
}

describe("resources", () => {
  const full = () => ({ ...ctx(), resources: resourcesStub() });

  it("lists with a cursor and pages through it", async () => {
    const first = await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/list" }, full());
    expect(first?.result).toEqual({ resources: [{ uri: "obsidian://vault/A.md", name: "A", mimeType: "text/markdown" }], nextCursor: "page2" });
    const second = await handleRpc({ jsonrpc: "2.0", id: 2, method: "resources/list", params: { cursor: "page2" } }, full());
    expect(second?.result).toEqual({ resources: [{ uri: "obsidian://vault/B.md", name: "B" }] });
  });

  it("lists templates", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/templates/list" }, full());
    expect(r?.result).toEqual({ resourceTemplates: [{ uriTemplate: "obsidian://vault/{path}", name: "note", mimeType: "text/markdown" }] });
  });

  it("reads a resource and reports a missing one with -32002", async () => {
    const ok = await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "obsidian://vault/A.md" } }, full());
    expect(ok?.result).toEqual({ contents: [{ uri: "obsidian://vault/A.md", mimeType: "text/markdown", text: "# A" }] });
    const missing = await handleRpc({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "obsidian://vault/Z.md" } }, full());
    expect(missing?.error?.code).toBe(RPC.RESOURCE_NOT_FOUND);
    const bad = await handleRpc({ jsonrpc: "2.0", id: 3, method: "resources/read" }, full());
    expect(bad?.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  it("answers empty when no provider is wired", async () => {
    expect((await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/list" }, ctx()))?.result).toEqual({ resources: [] });
    expect((await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/templates/list" }, ctx()))?.result).toEqual({ resourceTemplates: [] });
    expect((await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "x" } }, ctx()))?.error?.code).toBe(RPC.RESOURCE_NOT_FOUND);
  });
});

describe("prompts", () => {
  const full = () => ({ ...ctx(), prompts: promptsStub() });

  it("lists prompts", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "prompts/list" }, full());
    expect(r?.result).toEqual({ prompts: [{ name: "daily-rollup", title: "Daily rollup", arguments: [{ name: "focus", required: false }] }] });
  });

  it("gets a prompt with string arguments and rejects an unknown name", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "daily-rollup", arguments: { focus: "meetings" } } }, full());
    expect(r?.result).toEqual({ description: "Rollup", messages: [{ role: "user", content: { type: "text", text: "Roll up meetings" } }] });
    const missing = await handleRpc({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "nope" } }, full());
    expect(missing?.error?.code).toBe(RPC.INVALID_PARAMS);
    const noName = await handleRpc({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: {} }, full());
    expect(noName?.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  it("answers empty when no provider is wired", async () => {
    expect((await handleRpc({ jsonrpc: "2.0", id: 1, method: "prompts/list" }, ctx()))?.result).toEqual({ prompts: [] });
  });
});

// Pure JSON-RPC 2.0 + minimal MCP protocol handling. No Obsidian imports, so it
// can be unit-tested in isolation. The transport/server layer feeds raw request
// objects in and serializes the responses out.

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes.
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool handler receives validated args and returns text content. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ServerInfo {
  name: string;
  version: string;
}

export function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function err(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}

/** Validate the basic shape of an incoming JSON-RPC request. */
export function validateRequest(value: unknown): { req?: JsonRpcRequest; error?: JsonRpcError } {
  if (typeof value !== "object" || value === null) {
    return { error: { code: RPC.INVALID_REQUEST, message: "Request must be a JSON object" } };
  }
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") {
    return { error: { code: RPC.INVALID_REQUEST, message: "jsonrpc must be '2.0'" } };
  }
  if (typeof v.method !== "string" || v.method.length === 0) {
    return { error: { code: RPC.INVALID_REQUEST, message: "method must be a non-empty string" } };
  }
  return { req: v as unknown as JsonRpcRequest };
}

/**
 * Dispatch a validated MCP request against the supplied tool registry.
 * Handles the core MCP methods (initialize, tools/list, tools/call, ping).
 * Returns null for notifications that need no response.
 */
export async function handleRpc(
  req: JsonRpcRequest,
  ctx: {
    serverInfo: ServerInfo;
    tools: McpToolDef[];
    /** Explicit compatibility calls accepted without exposing them through tools/list. */
    hiddenTools?: ReadonlySet<string>;
    call: (name: string, args: Record<string, unknown>) => Promise<string>;
  },
): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: ctx.serverInfo,
      });

    case "notifications/initialized":
      return null; // notification, no response

    case "ping":
      return ok(req.id, {});

    case "tools/list":
      return ok(req.id, { tools: ctx.tools });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return err(req.id, RPC.INVALID_PARAMS, "tools/call requires a string 'name'");
      }
      if (!ctx.tools.some((t) => t.name === params.name) && !ctx.hiddenTools?.has(params.name)) {
        return err(req.id, RPC.METHOD_NOT_FOUND, `Unknown tool: ${params.name}`);
      }
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      try {
        const text = await ctx.call(params.name, args);
        return ok(req.id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        // Tool errors are reported as content with isError, per MCP convention.
        return ok(req.id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }

    default:
      if (isNotification(req)) return null;
      return err(req.id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

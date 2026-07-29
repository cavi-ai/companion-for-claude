// Client half of the MCP protocol: initialize handshake, tools/list, tools/call
// over an injected JSON-RPC transport (HTTP or stdio live in transports.ts).
// Pure — unit-tested with scripted transports.

import type { JsonRpcRequest, JsonRpcResponse, McpToolDef } from "./protocol";
import { MCP_PROTOCOL_VERSION } from "./protocol";

export interface McpTransport {
  /** Send one JSON-RPC message; resolves with the correlated reply, or null for notifications (HTTP 202). */
  send(message: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  close?(): Promise<void>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

const CLIENT_INFO = { name: "claude-companion", version: "0.1.0" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Parse the tools array of a tools/list result. Throws on a malformed shape. */
export function parseToolList(result: unknown): McpToolDef[] {
  const tools = asRecord(result)?.tools;
  if (!Array.isArray(tools)) throw new Error("MCP server returned a malformed tools/list result.");
  const out: McpToolDef[] = [];
  for (const entry of tools) {
    const tool = asRecord(entry);
    const name = text(tool?.name);
    if (!name) continue;
    out.push({
      name,
      description: text(tool?.description) ?? "",
      inputSchema: asRecord(tool?.inputSchema) ?? { type: "object" },
    });
  }
  return out;
}

/** Flatten a tools/call result's content blocks into one text payload. */
export function parseCallResult(result: unknown): McpCallResult {
  const obj = asRecord(result);
  const content = obj?.content;
  if (!Array.isArray(content)) throw new Error("MCP server returned a malformed tools/call result.");
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return { text: parts.join("\n"), isError: obj?.isError === true };
}

export class McpClientSession {
  private nextId = 1;
  private ready = false;

  constructor(private transport: McpTransport) {}

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const reply = await this.transport.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    if (reply === null) throw new Error(`MCP server did not reply to ${method}.`);
    if (reply.error) throw new Error(`MCP ${method} failed: ${reply.error.message}`);
    return reply.result;
  }

  /** Handshake once; subsequent calls are no-ops. */
  async initialize(): Promise<void> {
    if (this.ready) return;
    const result = asRecord(await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }));
    if (typeof result?.protocolVersion !== "string") throw new Error("MCP server returned a malformed initialize result.");
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.ready = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.initialize();
    return parseToolList(await this.request("tools/list"));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    return parseCallResult(await this.request("tools/call", { name, arguments: args }));
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

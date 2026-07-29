// Streamable-HTTP MCP transport: POST JSON-RPC to one endpoint, accept either a
// JSON reply or an SSE stream of message events. The HTTP call itself is
// injected (Obsidian's requestUrl in the app), so the framing unit-tests pure.

import type { JsonRpcResponse } from "./protocol";
import type { McpTransport } from "./client";

export interface HttpRequestLike {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpDo = (request: HttpRequestLike) => Promise<HttpResponseLike>;

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/** Extract the JSON-RPC messages from an SSE body (data: lines, blank-line separated). */
export function parseSseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A non-JSON event payload is not a protocol message — ignore it.
    }
  }
  return messages;
}

/** Pull the reply to `id` out of a response body that is either JSON or SSE. */
export function extractReply(body: string, contentType: string, id: string | number): JsonRpcResponse | null {
  if (contentType.includes("text/event-stream")) {
    for (const message of parseSseMessages(body)) {
      const reply = message as JsonRpcResponse;
      if (reply && typeof reply === "object" && reply.jsonrpc === "2.0" && reply.id === id) return reply;
    }
    return null;
  }
  try {
    const reply = JSON.parse(body) as JsonRpcResponse;
    return reply && reply.jsonrpc === "2.0" ? reply : null;
  } catch {
    return null;
  }
}

export function createHttpMcpTransport(url: string, headers: Record<string, string>, http: HttpDo): McpTransport {
  let sessionId: string | undefined;
  return {
    async send(message) {
      const response = await http({
        url,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(message),
      });
      const sid = header(response.headers, "mcp-session-id");
      if (sid) sessionId = sid;
      if (response.status === 202 || response.status === 204) return null; // notification accepted
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`MCP server responded ${response.status} — check the server URL and that it's running.`);
      }
      if (message.id === undefined || message.id === null) return null;
      const reply = extractReply(response.body, header(response.headers, "content-type") ?? "application/json", message.id);
      if (reply === null) throw new Error("MCP server returned no matching reply (malformed response).");
      return reply;
    },
  };
}

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
    } catch (e) {
      console.debug("Claude Companion: MCP SSE event JSON parse failed", e);
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
  } catch (e) {
    console.debug("Claude Companion: MCP HTTP response JSON parse failed", e);
    return null;
  }
}

export function createHttpMcpTransport(
  url: string,
  headers: Record<string, string>,
  http: HttpDo,
  timeoutMs = 60_000,
): McpTransport {
  let sessionId: string | undefined;
  const inFlight = new Set<() => void>();

  return {
    send(message) {
      return new Promise<JsonRpcResponse | null>((resolve, reject) => {
        let settled = false;
        let timer = 0;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          inFlight.delete(onClose);
          fn();
        };

        const onClose = (): void => finish(() => reject(new Error("MCP server connection closed.")));

        timer = window.setTimeout(() => {
          finish(() => reject(new Error(`MCP server did not reply to ${String(message.method)} within ${timeoutMs / 1000}s.`)));
        }, timeoutMs);
        inFlight.add(onClose);

        http({
          url,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify(message),
        }).then(
          (response) => {
            if (settled) return; // requestUrl can't be aborted; a reply after the deadline is discarded, never adopted
            finish(() => {
              const sid = header(response.headers, "mcp-session-id");
              if (sid) sessionId = sid;
              if (response.status === 202 || response.status === 204) { resolve(null); return; } // notification accepted
              if (response.status < 200 || response.status >= 300) {
                reject(new Error(`MCP server responded ${response.status} — check the server URL and that it's running.`));
                return;
              }
              if (message.id === undefined || message.id === null) { resolve(null); return; }
              const reply = extractReply(response.body, header(response.headers, "content-type") ?? "application/json", message.id);
              if (reply === null) { reject(new Error("MCP server returned no matching reply (malformed response).")); return; }
              resolve(reply);
            });
          },
          (err) => {
            if (settled) return; // late rejection: discarded, and always handled here so it never surfaces as unhandled
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          },
        );
      });
    },
    async close() {
      for (const onClose of Array.from(inFlight)) onClose();
    },
  };
}

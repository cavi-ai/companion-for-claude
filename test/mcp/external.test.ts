import { describe, expect, it } from "vitest";
import { externalAnthropicTools, externalToolName, parseExternalToolName } from "../../src/mcp/external";
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
});

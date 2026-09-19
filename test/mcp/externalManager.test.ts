import { describe, expect, it, vi } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));
vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, requestUrl: requestUrlMock };
});

import { ExternalMcpManager } from "../../src/mcp/externalManager";
import type { McpServerConfig } from "../../src/types";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

const config = (url: string): McpServerConfig => ({
  name: "docs",
  enabled: true,
  transport: "http",
  url,
  command: "",
  args: "",
});

function connection(label: string) {
  return {
    exposedAs: "docs",
    tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    session: {
      close: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({ text: label, isError: false }),
    },
  };
}

const namedConfig = (name: string, url: string): McpServerConfig => ({ ...config(url), name });

function replaceConnect(manager: ExternalMcpManager, implementation: (config: McpServerConfig) => Promise<ReturnType<typeof connection>>) {
  const seam = manager as unknown as { connect(config: McpServerConfig): Promise<ReturnType<typeof connection>> };
  return vi.spyOn(seam, "connect").mockImplementation(implementation);
}

describe("ExternalMcpManager lifecycle", () => {
  it("coalesces concurrent discovery for the same server into one session", async () => {
    const gate = deferred<ReturnType<typeof connection>>();
    const manager = new ExternalMcpManager(() => [config("https://one.test/mcp")]);
    const connect = replaceConnect(manager, () => gate.promise);

    const first = manager.servers();
    const second = manager.servers();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    gate.resolve(connection("one"));
    await Promise.all([first, second]);

    expect(connect).toHaveBeenCalledOnce();
  });

  it("closes a session that finishes connecting after close begins", async () => {
    const gate = deferred<ReturnType<typeof connection>>();
    const conn = connection("late");
    const manager = new ExternalMcpManager(() => [config("https://one.test/mcp")]);
    const connect = replaceConnect(manager, () => gate.promise);

    const discovery = manager.servers();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const closing = manager.close();
    gate.resolve(conn);
    await Promise.all([discovery, closing]);

    expect(conn.session.close).toHaveBeenCalledOnce();
    await expect(manager.call("mcp__docs__search", {})).rejects.toThrow(/not connected/i);
  });

  it("does not let an old connection overwrite a replacement configuration", async () => {
    let configs = [config("https://old.test/mcp")];
    const oldGate = deferred<ReturnType<typeof connection>>();
    const newGate = deferred<ReturnType<typeof connection>>();
    const oldConn = connection("old");
    const newConn = connection("new");
    const manager = new ExternalMcpManager(() => configs);
    const connect = replaceConnect(manager, (next) => next.url.includes("old") ? oldGate.promise : newGate.promise);

    const oldDiscovery = manager.servers();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const closing = manager.close();
    configs = [config("https://new.test/mcp")];
    const newDiscovery = manager.servers();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    newGate.resolve(newConn);
    await newDiscovery;
    oldGate.resolve(oldConn);
    await Promise.all([oldDiscovery, closing]);

    await expect(manager.call("mcp__docs__search", {})).resolves.toBe("new");
    expect(oldConn.session.close).toHaveBeenCalledOnce();
  });

  it("does not publish a settings test connection that completes after close", async () => {
    const gate = deferred<ReturnType<typeof connection>>();
    const conn = connection("late test");
    const manager = new ExternalMcpManager(() => []);
    const connect = replaceConnect(manager, () => gate.promise);

    const testing = manager.test(config("https://one.test/mcp"));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const closing = manager.close();
    gate.resolve(conn);
    await Promise.all([testing, closing]);

    expect(conn.session.close).toHaveBeenCalledOnce();
    await expect(manager.call("mcp__docs__search", {})).rejects.toThrow(/not connected/i);
  });

  it("does not let an older discovery overwrite a fresh settings test session", async () => {
    const discoveryGate = deferred<ReturnType<typeof connection>>();
    const testGate = deferred<ReturnType<typeof connection>>();
    const discovered = connection("discovered");
    const tested = connection("tested");
    const manager = new ExternalMcpManager(() => [config("https://one.test/mcp")]);
    let calls = 0;
    const connect = replaceConnect(manager, () => calls++ === 0 ? discoveryGate.promise : testGate.promise);

    const discovery = manager.servers();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const testing = manager.test(config("https://one.test/mcp"));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    testGate.resolve(tested);
    await testing;
    discoveryGate.resolve(discovered);
    await discovery;

    await expect(manager.call("mcp__docs__search", {})).resolves.toBe("tested");
    expect(discovered.session.close).toHaveBeenCalledOnce();
  });
});

describe("ExternalMcpManager name routing", () => {
  /** Serve initialize, tools/list and tools/call over the injected HTTP surface. */
  function serveMcp(): void {
    requestUrlMock.mockImplementation(async (req: { body: string }) => {
      const message = JSON.parse(req.body) as { id?: number; method: string };
      if (message.method === "notifications/initialized") return { status: 202, headers: {}, text: "" };
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
      else if (message.method === "tools/list") result = { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] };
      else result = { content: [{ type: "text", text: "hit" }], isError: false };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result }),
      };
    });
  }

  it("routes a call for a server whose configured name needs sanitizing", async () => {
    serveMcp();
    const manager = new ExternalMcpManager(() => [namedConfig("My Server", "https://one.test/mcp")]);

    const servers = await manager.servers();
    expect(servers[0]?.server).toBe("My-Server");
    // The model calls the sanitized name; it must route back, not throw "not connected".
    await expect(manager.call("mcp__My-Server__search", { q: "x" })).resolves.toBe("hit");
  });

  it("routes a server whose name contains the __ separator without ambiguity", async () => {
    serveMcp();
    const manager = new ExternalMcpManager(() => [namedConfig("my__server", "https://one.test/mcp")]);

    const servers = await manager.servers();
    expect(servers[0]?.server).toBe("my_server");
    await expect(manager.call("mcp__my_server__search", {})).resolves.toBe("hit");
  });

  it("times out a tool call whose server never replies, instead of hanging the turn", async () => {
    vi.useFakeTimers();
    try {
      requestUrlMock.mockImplementation(async (req: { body: string }) => {
        const message = JSON.parse(req.body) as { id?: number; method: string };
        if (message.method === "notifications/initialized") return { status: 202, headers: {}, text: "" };
        if (message.method === "initialize") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }),
          };
        }
        if (message.method === "tools/list") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] } }),
          };
        }
        return new Promise(() => {}); // tools/call: server accepts but never replies
      });
      const manager = new ExternalMcpManager(() => [namedConfig("docs", "https://one.test/mcp")]);
      await manager.servers();

      const pending = manager.call("mcp__docs__search", {});
      const assertion = expect(pending).rejects.toThrow(/did not reply to tools\/call within 60s/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

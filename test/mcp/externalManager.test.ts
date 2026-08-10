import { describe, expect, it, vi } from "vitest";
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

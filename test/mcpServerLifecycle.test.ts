import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpServer } from "../src/mcp/server";

interface FakeHttpServer {
  on(event: string, handler: (error: unknown) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: () => void): void;
  address(): null;
}

afterEach(() => vi.unstubAllGlobals());

describe("McpHttpServer lifecycle", () => {
  it("closes a listener whose stop is requested while start is still pending", async () => {
    let finishListen: (() => void) | null = null;
    let closeCount = 0;
    const fakeServer: FakeHttpServer = {
      on: () => undefined,
      listen: (_port, _host, callback) => { finishListen = callback; },
      close: (callback) => { closeCount++; callback(); },
      address: () => null,
    };
    vi.stubGlobal("window", {
      require: () => ({ createServer: () => fakeServer }),
    });

    const tools = { definitions: () => [], call: async () => "" };
    const server = new McpHttpServer(
      { port: 0, token: "secret", serverInfo: { name: "test", version: "1" } },
      tools as never,
    );

    const starting = server.start();
    await Promise.resolve();
    const stopping = server.stop();
    finishListen?.();
    await Promise.all([starting, stopping]);

    expect(closeCount).toBe(1);
    expect(server.isRunning()).toBe(false);
  });
});

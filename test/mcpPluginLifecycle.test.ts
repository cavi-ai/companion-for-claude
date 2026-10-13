import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpServer } from "../src/mcp/server";
import { DEFAULT_SETTINGS } from "../src/types";
import { buildPlugin } from "./fakes/plugin";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("plugin MCP lifecycle", () => {
  it("does not publish a bridge that finishes starting after plugin unload", async () => {
    const startGate = deferred();
    const start = vi.spyOn(McpHttpServer.prototype, "start").mockImplementation(() => startGate.promise);
    const stop = vi.spyOn(McpHttpServer.prototype, "stop").mockResolvedValue(undefined);
    const plugin = buildPlugin({
      settings: { ...structuredClone(DEFAULT_SETTINGS), mcpEnabled: true, mcpToken: "secret" },
      mcpSyncChain: Promise.resolve(),
      mcpServer: null,
      mcpSignature: null,
      vaultTools: null,
      reindexTimer: null,
    });

    const syncing = plugin.syncMcpServer();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    plugin.onunload();
    startGate.resolve();
    await syncing;

    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.mcpRunning()).toBe(false);
  });
});

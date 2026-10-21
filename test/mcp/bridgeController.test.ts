import { describe, expect, it, vi } from "vitest";
import { McpBridgeController, type McpBridgeControllerDeps } from "../../src/mcp/bridgeController";
import { DEFAULT_SETTINGS } from "../../src/types";

function controller(started: McpBridgeControllerDeps["started"]) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), mcpEnabled: true, mcpPort: 22361, mcpToken: "bridge-token" };
  let running = false;
  const createServer = vi.fn(async () => ({
    isRunning: () => running,
    start: async () => { running = true; },
    stop: async () => { running = false; },
    address: () => ({ port: settings.mcpPort }),
    stats: () => ({ activeRequests: 0, handledRequests: 0 }),
  }));
  const bridge = new McpBridgeController({
    settings: () => settings,
    saveSettings: async () => undefined,
    isMobile: false,
    isLifecycleEnded: () => false,
    lifecycleGeneration: () => 1,
    buildToolOptions: () => ({}) as never,
    createTools: () => ({ setOptions: () => undefined }),
    createServer,
    notice: () => undefined,
    started,
  });
  return { bridge, settings, createServer };
}

describe("McpBridgeController", () => {
  it("reports the port and token once the bridge is listening, and again only after either changes", async () => {
    const started = vi.fn(async () => undefined);
    const { bridge, settings } = controller(started);
    await bridge.sync();
    expect(started).toHaveBeenCalledWith(22361, "bridge-token");
    await bridge.sync();
    expect(started).toHaveBeenCalledTimes(1);
    settings.mcpToken = "rotated-token";
    await bridge.sync();
    expect(started).toHaveBeenLastCalledWith(22361, "rotated-token");
  });

  it("keeps the bridge running when the follow-up fails", async () => {
    const { bridge } = controller(async () => { throw new Error("no connection file"); });
    await bridge.sync();
    expect(bridge.running()).toBe(true);
  });
});

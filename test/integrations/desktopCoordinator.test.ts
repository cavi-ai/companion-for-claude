import { describe, expect, it } from "vitest";
import { DesktopIntegrationCoordinator, type DesktopIntegrationRuntime } from "../../src/integrations/desktopCoordinator";
import type { ClaudeCodeInspection } from "../../src/integrations/desktop";

const ready: ClaudeCodeInspection = {
  claude: { available: true, version: "2.1.226" },
  obsidian: { available: true, version: "1.12.7" },
  marketplaceInstalled: true,
  pluginInstalled: true,
  pluginEnabled: true,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const runtime = (overrides: Partial<DesktopIntegrationRuntime> = {}): DesktopIntegrationRuntime => ({
  inspectClaudeCode: async () => ready,
  setupClaudeCode: async () => ready,
  installClaudeDesktop: async () => ({ configPath: "/config.json", backupPath: null, restartRequired: true }),
  openTerminalAtVault: async () => ({ opened: true }),
  ...overrides,
});

describe("DesktopIntegrationCoordinator", () => {
  it("coalesces concurrent refreshes into one runtime inspection", async () => {
    const pending = deferred<ClaudeCodeInspection>();
    let calls = 0;
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ inspectClaudeCode: async () => { calls += 1; return pending.promise; } }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "secret" }),
      copy: async () => undefined,
    });

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(calls).toBe(1);
    pending.resolve(ready);
    await Promise.all([first, second]);
    expect(coordinator.snapshot().inspection).toEqual(ready);
  });

  it("coalesces concurrent setup clicks and reuses one confirmation", async () => {
    const pending = deferred<ClaudeCodeInspection>();
    let setupCalls = 0;
    let confirmCalls = 0;
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ setupClaudeCode: async () => { setupCalls += 1; return pending.promise; } }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "secret" }),
      copy: async () => undefined,
    });
    const confirm = async () => { confirmCalls += 1; return true; };

    const first = coordinator.setupClaudeCode(confirm);
    const second = coordinator.setupClaudeCode(confirm);
    await Promise.resolve();
    expect(confirmCalls).toBe(1);
    expect(setupCalls).toBe(1);
    pending.resolve(ready);
    await Promise.all([first, second]);
    expect(coordinator.snapshot().message).toContain("ready");
  });

  it("does not mutate external state when confirmation is denied", async () => {
    let setupCalls = 0;
    let bridgeCalls = 0;
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ setupClaudeCode: async () => { setupCalls += 1; return ready; } }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => { bridgeCalls += 1; return { port: 22360, token: "secret" }; },
      copy: async () => undefined,
    });

    await coordinator.setupClaudeCode(async () => false);
    await coordinator.connectClaudeDesktop(async () => false);
    expect(setupCalls).toBe(0);
    expect(bridgeCalls).toBe(0);
  });

  it("discards late refresh results after disposal", async () => {
    const pending = deferred<ClaudeCodeInspection>();
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ inspectClaudeCode: async () => pending.promise }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "secret" }),
      copy: async () => undefined,
    });
    let notifications = 0;
    coordinator.subscribe(() => { notifications += 1; });
    const refresh = coordinator.refresh();
    const beforeDispose = notifications;
    coordinator.dispose();
    pending.resolve(ready);
    await refresh;
    expect(notifications).toBe(beforeDispose);
    expect(coordinator.snapshot().inspection).toBeUndefined();
  });

  it("configures Claude Desktop with a prepared read-only bridge and hides its token", async () => {
    let installInput: { port: number; token: string } | undefined;
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({
        installClaudeDesktop: async (input) => {
          installInput = input;
          return { configPath: "/config.json", backupPath: "/config.backup", restartRequired: true };
        },
      }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "private-bridge-token" }),
      copy: async () => undefined,
    });

    await coordinator.connectClaudeDesktop(async () => true);
    expect(installInput).toEqual({ port: 22360, token: "private-bridge-token" });
    expect(JSON.stringify(coordinator.snapshot())).not.toContain("private-bridge-token");
    expect(coordinator.snapshot().message).toContain("Restart Claude Desktop");
  });

  it("keeps setup errors inline, actionable, and secret-free", async () => {
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ setupClaudeCode: async () => { throw new Error("Authorization: Bearer secret-value"); } }),
      providerReady: () => false,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "bridge-secret" }),
      copy: async () => undefined,
    });

    await coordinator.setupClaudeCode(async () => true);
    const state = coordinator.snapshot();
    expect(state.providerReady).toBe(false);
    expect(state.status).toBe("error");
    expect(state.error?.recovery).toBe("retry-claude-code");
    expect(state.error?.message).not.toContain("secret-value");
  });

  it("routes bridge startup failures to advanced bridge settings", async () => {
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime(),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => { throw new Error("The read-only MCP bridge could not start on port 22360."); },
      copy: async () => undefined,
    });
    await coordinator.connectClaudeDesktop(async () => true);
    expect(coordinator.snapshot().error).toEqual({
      message: "The read-only MCP bridge could not start on port 22360.",
      recovery: "open-bridge-settings",
    });
  });

  it("copies a safe terminal fallback when no launcher is available", async () => {
    const copied: string[] = [];
    const coordinator = new DesktopIntegrationCoordinator({
      runtime: runtime({ openTerminalAtVault: async () => ({ opened: false, instruction: "cd '/Vault' && claude" }) }),
      providerReady: () => true,
      vaultPath: "/Vault",
      prepareClaudeDesktopBridge: async () => ({ port: 22360, token: "secret" }),
      copy: async (text) => { copied.push(text); },
    });

    await coordinator.openTerminal();
    expect(copied).toEqual(["cd '/Vault' && claude"]);
    expect(coordinator.snapshot().message).toContain("copied");
  });
});

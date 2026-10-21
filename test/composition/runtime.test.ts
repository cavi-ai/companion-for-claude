import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

type Deps = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;

const captured = vi.hoisted(() => ({
  build: undefined as Deps | undefined,
  bridge: undefined as Deps | undefined,
  optimize: undefined as Deps | undefined,
  modals: [] as { args: unknown[]; opened: number }[],
  tools: [] as { args: unknown[]; calls: unknown[][] }[],
  servers: [] as { args: unknown[] }[],
}));

vi.mock("../../src/build/controller", () => ({
  BuildController: class {
    constructor(deps: Deps) {
      captured.build = deps;
    }
  },
}));
vi.mock("../../src/mcp/bridgeController", () => ({
  McpBridgeController: class {
    constructor(deps: Deps) {
      captured.bridge = deps;
    }
  },
}));
vi.mock("../../src/optimize/feature", () => ({
  OptimizeFeature: class {
    constructor(deps: Deps) {
      captured.optimize = deps;
    }
  },
}));
vi.mock("../../src/view/ConfirmModal", () => ({
  ConfirmModal: class {
    record = { args: [] as unknown[], opened: 0 };
    constructor(...args: unknown[]) {
      this.record.args = args;
      captured.modals.push(this.record);
    }
    open = (): void => {
      this.record.opened += 1;
    };
  },
}));
vi.mock("../../src/vault/vaultFiles", () => ({
  ensureVaultFolder: vi.fn(async () => "ensured"),
}));
vi.mock("../../src/composition/vaultTools", () => ({ vaultToolOptions: vi.fn(() => ({ options: true })) }));
vi.mock("../../src/mcp/vaultTools", () => ({
  VaultTools: class {
    record = { args: [] as unknown[], calls: [] as unknown[][] };
    constructor(...args: unknown[]) {
      this.record.args = args;
      captured.tools.push(this.record);
    }
    call = (...args: unknown[]): string => {
      this.record.calls.push(args);
      return "tool-result";
    };
  },
}));
vi.mock("../../src/mcp/server", () => ({
  McpHttpServer: class {
    constructor(...args: unknown[]) {
      captured.servers.push({ args });
    }
  },
}));
vi.mock("../../src/mcp/providers", () => ({
  substrateResourceProvider: vi.fn(() => "substrate"),
  vaultResourceProvider: vi.fn(() => "vault"),
  composeResourceProviders: vi.fn(() => "composed"),
  catalogPromptProvider: vi.fn(() => "prompts"),
}));

import { Platform, clearNotices, getNoticeMessages, normalizePath } from "obsidian";
import {
  buildBuildController,
  buildMcpBridge,
  buildOptimize,
  type BuildHost,
  type McpBridgeHost,
  type OptimizeHost,
} from "../../src/composition/runtime";
import { vaultToolOptions } from "../../src/composition/vaultTools";
import { catalogPromptProvider, composeResourceProviders, substrateResourceProvider, vaultResourceProvider } from "../../src/mcp/providers";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { ensureVaultFolder } from "../../src/vault/vaultFiles";

const call = <T>(deps: Deps | undefined, name: string, ...args: unknown[]): T => (deps![name] as (...a: unknown[]) => T)(...args);

beforeEach(() => {
  captured.build = undefined;
  captured.bridge = undefined;
  captured.optimize = undefined;
  captured.modals = [];
  captured.tools = [];
  captured.servers = [];
  vi.mocked(ensureVaultFolder).mockClear();
  vi.mocked(vaultToolOptions).mockClear();
  vi.mocked(substrateResourceProvider).mockClear();
  vi.mocked(vaultResourceProvider).mockClear();
  vi.mocked(composeResourceProviders).mockClear();
  vi.mocked(catalogPromptProvider).mockClear();
  clearNotices();
});

afterEach(() => {
  Platform.isMobile = false;
  Platform.isDesktop = true;
  vi.unstubAllGlobals();
});

describe("buildBuildController", () => {
  function rig() {
    const note = new TFile("Plans/a.md", "", 1);
    const m = {
      getAbstractFileByPath: vi.fn((p: string) => (p === note.path ? note : p === "folder" ? { path: "folder" } : null)),
      cachedRead: vi.fn(async () => "cached"),
      process: vi.fn(async () => "processed"),
      create: vi.fn(async () => undefined),
      openFile: vi.fn(async () => undefined),
      getLeaf: vi.fn(),
      persist: vi.fn(async () => undefined),
      cloud: vi.fn(() => ({ cloud: true })),
      vaultBasePath: vi.fn(() => "/vault"),
    };
    m.getLeaf.mockReturnValue({ openFile: m.openFile });
    const host = {
      app: {
        vault: { getAbstractFileByPath: m.getAbstractFileByPath, cachedRead: m.cachedRead, process: m.process, create: m.create },
        workspace: { getLeaf: m.getLeaf },
      },
      settings: { s: 1 },
      persist: m.persist,
      publishing: () => ({ cloud: m.cloud }),
      vaultBasePath: m.vaultBasePath,
    } as unknown as BuildHost;
    const desktopRuntimeLoader = vi.fn(async () => ({ runtime: true }));
    buildBuildController(host, { desktopRuntimeLoader: desktopRuntimeLoader as never });
    return { host, m, note, desktopRuntimeLoader };
  }

  it("forwards host members and the platform flag", async () => {
    const { host, m, desktopRuntimeLoader } = rig();
    const d = captured.build!;
    expect(call(d, "settings")).toBe(host.settings);
    await call(d, "persist");
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(d.isMobile).toBe(Platform.isMobile);
    expect(call(d, "cloud")).toEqual({ cloud: true });
    expect(call(d, "vaultBasePath")).toBe("/vault");
    expect(d.normalizePath).toBe(normalizePath);
    expect(d.desktopRuntimeLoader).toBe(desktopRuntimeLoader);
  });

  it("reads the mobile flag from the platform", () => {
    Platform.isMobile = true;
    rig();
    expect(captured.build!.isMobile).toBe(true);
  });

  it("reads window.process for the desktop process", () => {
    rig();
    const process = { platform: "darwin", env: {} };
    vi.stubGlobal("window", { process });
    expect(call(captured.build, "desktopProcess")).toBe(process);
  });

  it("shows notices", () => {
    rig();
    call(captured.build, "notice", "m", 5);
    expect(getNoticeMessages()).toEqual(["m"]);
  });

  it("cachedRead reads files and rejects non-files", async () => {
    const { m, note } = rig();
    const vault = captured.build!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(vault.cachedRead!("Plans/a.md")).resolves.toBe("cached");
    expect(m.cachedRead).toHaveBeenCalledWith(note);
    await expect(vault.cachedRead!("folder")).rejects.toThrow("File not found: folder");
    expect(m.cachedRead).toHaveBeenCalledTimes(1);
  });

  it("processFile runs vault.process for a file only", async () => {
    const { m, note } = rig();
    const vault = captured.build!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = vi.fn();
    await vault.processFile!("Plans/a.md", fn);
    expect(m.process).toHaveBeenCalledWith(note, fn);
    await expect(vault.processFile!("folder", fn)).rejects.toThrow("File not found");
    await expect(vault.processFile!("missing", fn)).rejects.toThrow("File not found");
    expect(m.process).toHaveBeenCalledTimes(1);
  });

  it("creates new build documents without an overwrite helper", async () => {
    const { host, m } = rig();
    await expect(call<Promise<void>>(captured.build, "createFile", "a/b.md", "body")).resolves.toBeUndefined();
    expect(m.create).toHaveBeenCalledWith("a/b.md", "body");
    const vault = captured.build!.vault as { exists(path: string): boolean };
    expect(vault.exists("Plans/a.md")).toBe(true);
    expect(vault.exists("folder")).toBe(true);
    expect(vault.exists("missing")).toBe(false);
    await expect(call<Promise<string>>(captured.build, "ensureFolder", "a")).resolves.toBe("ensured");
    expect(ensureVaultFolder).toHaveBeenCalledWith(host.app, "a");
  });

  it("openFile opens a file in the current leaf and rejects non-files", async () => {
    const { m, note } = rig();
    await call<Promise<void>>(captured.build, "openFile", "Plans/a.md");
    expect(m.getLeaf).toHaveBeenCalledWith(false);
    expect(m.openFile).toHaveBeenCalledWith(note);
    m.openFile.mockClear();
    await expect(call<Promise<void>>(captured.build, "openFile", "folder")).rejects.toThrow("File not found");
    expect(m.openFile).not.toHaveBeenCalled();
  });

  it("confirm opens a ConfirmModal on the app and resolves with onResolve", async () => {
    const { host } = rig();
    const opts = { title: "t", message: "m" };
    const result = call<Promise<boolean>>(captured.build, "confirm", opts);
    expect(captured.modals).toHaveLength(1);
    expect(captured.modals[0]!.opened).toBe(1);
    expect(captured.modals[0]!.args[0]).toBe(host.app);
    const modalOpts = captured.modals[0]!.args[1] as { title: string; message: string; onResolve: (v: boolean) => void };
    expect(modalOpts).toMatchObject(opts);
    modalOpts.onResolve(true);
    await expect(result).resolves.toBe(true);
  });
});

describe("buildMcpBridge", () => {
  function rig() {
    const m = {
      saveSettings: vi.fn(async () => undefined),
      memoryNotePath: vi.fn(() => "Claude/memory.md"),
      promptTemplates: vi.fn(() => [{ name: "t" }]),
      refreshClaudeDesktopConnection: vi.fn(async () => undefined),
    };
    const host = {
      app: { app: true },
      manifest: { version: "9.9.9" },
      settings: { s: 1, mcpAllowWrites: true },
      saveSettings: m.saveSettings,
      memoryNotePath: m.memoryNotePath,
      promptTemplates: m.promptTemplates,
      desktopIntegrations: () => ({ refreshClaudeDesktopConnection: m.refreshClaudeDesktopConnection }),
    } as unknown as McpBridgeHost;
    const wiring = { isLifecycleEnded: vi.fn(() => true), lifecycleGeneration: vi.fn(() => 7) };
    buildMcpBridge(host, wiring);
    return { host, m, wiring };
  }

  it("forwards host members and the lifecycle wiring", async () => {
    const { host, m, wiring } = rig();
    const d = captured.bridge!;
    expect(call(d, "settings")).toBe(host.settings);
    await call(d, "saveSettings");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(d.isMobile).toBe(Platform.isMobile);
    expect(d.isLifecycleEnded).toBe(wiring.isLifecycleEnded);
    expect(d.lifecycleGeneration).toBe(wiring.lifecycleGeneration);
    expect(call(d, "isLifecycleEnded")).toBe(true);
    expect(call(d, "lifecycleGeneration")).toBe(7);
  });

  it("reads the mobile flag from the platform", () => {
    Platform.isMobile = true;
    rig();
    expect(captured.bridge!.isMobile).toBe(true);
  });

  it("shows notices", () => {
    rig();
    call(captured.bridge, "notice", "m");
    expect(getNoticeMessages()).toEqual(["m"]);
  });

  it("keeps Claude Desktop's connection on the bridge's port and token once it starts", async () => {
    const { m } = rig();
    await call(captured.bridge, "started", 22361, "tok");
    expect(m.refreshClaudeDesktopConnection).toHaveBeenCalledWith(22361, "tok");
  });

  it("builds tool options from the write gate", () => {
    const { host } = rig();
    expect(call(captured.bridge, "buildToolOptions")).toEqual({ options: true });
    expect(vaultToolOptions).toHaveBeenCalledWith(host, true);
  });

  it("creates VaultTools on the app with the options", () => {
    const { host } = rig();
    const opts = { allowWrites: false };
    call(captured.bridge, "createTools", opts);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]!.args[0]).toBe(host.app);
    expect(captured.tools[0]!.args[1]).toBe(opts);
  });

  it("creates the HTTP server with info, composed resources, prompts and an error-only logger", async () => {
    const { host, m } = rig();
    const tools = { call: vi.fn(() => "forwarded") };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await call<Promise<unknown>>(captured.bridge, "createServer", tools, 4321, "tok");
    expect(captured.servers).toHaveLength(1);
    const [config, serverTools, log] = captured.servers[0]!.args as [Record<string, unknown>, unknown, (level: string, message: string) => void];
    expect(config).toEqual({
      port: 4321,
      token: "tok",
      serverInfo: { name: "obsidian-vault", version: "9.9.9" },
      resources: "composed",
      prompts: "prompts",
    });
    expect(serverTools).toBe(tools);

    const [app, substrate] = vi.mocked(substrateResourceProvider).mock.calls[0]!;
    expect(app).toBe(host.app);
    expect((substrate.call as (n: string, a: unknown) => unknown)("note_read", { path: "p" })).toBe("forwarded");
    expect(tools.call).toHaveBeenCalledWith("note_read", { path: "p" });
    expect(substrate.memoryPath()).toBe("Claude/memory.md");
    expect(m.memoryNotePath).toHaveBeenCalledTimes(1);
    expect(vaultResourceProvider).toHaveBeenCalledWith(host.app);
    expect(composeResourceProviders).toHaveBeenCalledWith("substrate", "vault");
    const promptsFn = vi.mocked(catalogPromptProvider).mock.calls[0]![0];
    expect(promptsFn()).toEqual([{ name: "t" }]);
    expect(m.promptTemplates).toHaveBeenCalledTimes(1);

    log("info", "quiet");
    expect(error).not.toHaveBeenCalled();
    log("error", "boom");
    expect(error).toHaveBeenCalledWith("[Claude Companion MCP]", "boom");
    error.mockRestore();
  });
});

describe("buildOptimize", () => {
  function rig(selection: { state: string } = { state: "configured-provider" }, ended = false) {
    const m = {
      indexer: vi.fn(() => ({ indexer: true })),
      ontology: vi.fn(() => ({ ontology: true })),
      tagTriggers: vi.fn(() => [{ path: "p", tag: "t" }]),
      runtimeSelection: vi.fn(() => selection),
      unavailableMessage: vi.fn(() => "unavailable-message"),
      isEnded: vi.fn(() => ended),
      persist: vi.fn(async () => undefined),
    };
    const order: string[] = [];
    const host = {
      app: { app: true },
      settings: { s: 1 },
      activity: { a: 1 },
      router: vi.fn(() => ({ r: 1 })),
      semantic: () => ({ indexer: m.indexer }),
      ontology: m.ontology,
      standingOrders: () => ({ tagTriggers: m.tagTriggers }),
      utilityRouting: () => ({ runtimeSelection: m.runtimeSelection, unavailableMessage: m.unavailableMessage, isEnded: m.isEnded }),
      persist: vi.fn(async () => { order.push("persist"); }),
    } as unknown as OptimizeHost;
    const state = { value: { dismissed: ["x"], verdicts: {} }, get: vi.fn(), set: vi.fn((next: unknown) => { order.push("set"); state.value = next as typeof state.value; }) };
    state.get.mockImplementation(() => state.value);
    buildOptimize(host, { state: { get: state.get, set: state.set } });
    return { host, m, state, order };
  }

  it("forwards host members and the platform flag", () => {
    const { host } = rig();
    const d = captured.optimize!;
    expect(d.app).toBe(host.app);
    expect(call(d, "settings")).toBe(host.settings);
    expect(call(d, "activity")).toBe(host.activity);
    expect(call(d, "router")).toEqual({ r: 1 });
    expect(d.isMobile).toBe(Platform.isMobile);
  });

  it("reads the mobile flag from the platform", () => {
    Platform.isMobile = true;
    rig();
    expect(captured.optimize!.isMobile).toBe(true);
  });

  it("reaches the indexer, ontology and standing-order tag triggers", () => {
    const { m } = rig();
    const d = captured.optimize!;
    expect(call(d, "indexer")).toEqual({ indexer: true });
    expect(m.indexer).toHaveBeenCalledTimes(1);
    expect(call(d, "ontology")).toEqual({ ontology: true });
    expect(m.ontology).toHaveBeenCalledTimes(1);
    expect(call(d, "orderTagTriggers")).toEqual([{ path: "p", tag: "t" }]);
    expect(m.tagTriggers).toHaveBeenCalledTimes(1);
  });

  it.each(["configured-provider", "approved-Claude-fallback"])("passiveUtilitySelection returns the selection in state %s", (state) => {
    const selection = { state };
    const { m } = rig(selection);
    expect(call(captured.optimize, "passiveUtilitySelection")).toBe(selection);
    expect(m.unavailableMessage).not.toHaveBeenCalled();
  });

  it("passiveUtilitySelection throws UtilityUnavailableError with the message and selection otherwise", () => {
    const selection = { state: "needs-consent" };
    const { m } = rig(selection);
    let thrown: unknown;
    try {
      call(captured.optimize, "passiveUtilitySelection");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UtilityUnavailableError);
    expect((thrown as UtilityUnavailableError).message).toBe("unavailable-message");
    expect((thrown as UtilityUnavailableError).resolution).toBe(selection);
    expect(m.unavailableMessage).toHaveBeenCalledWith(selection);
  });

  it("assertActive throws the unload message only once the lifecycle has ended", () => {
    rig(undefined, true);
    expect(() => call(captured.optimize, "assertActive")).toThrow("Companion unloaded while the model check was running; no further content was sent.");
    rig(undefined, false);
    expect(call(captured.optimize, "assertActive")).toBeUndefined();
  });

  it("getState reads the wiring state and setState writes it before persisting", async () => {
    const { host, state, order } = rig();
    const d = captured.optimize!;
    expect(call(d, "getState")).toBe(state.value);
    const next = { dismissed: ["y"], verdicts: {} };
    await call<Promise<void>>(d, "setState", next);
    expect(state.set).toHaveBeenCalledWith(next);
    expect(host.persist).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["set", "persist"]);
    expect(call(d, "getState")).toBe(next);
  });
});

import { describe, expect, it } from "vitest";
import {
  addMcpServer, cachedModelHint, canDeleteDeviceModel, editMcpServer, regenerateMcpToken, removeMcpServer, selectEmbedding,
  setCredential, setMcpEnabled, showCachedModelHint,
} from "../../src/settingsItems/actions";
import { DEFAULT_SETTINGS, type McpServerConfig, type PluginSettings } from "../../src/types";

const fresh = (): PluginSettings => structuredClone(DEFAULT_SETTINGS);
const server = (): McpServerConfig => ({ name: "n", enabled: true, transport: "http", url: "", command: "", args: "" });

describe("setCredential", () => {
  it("stores the value trimmed", () => {
    const s = fresh();
    setCredential(s, "apiKey", "  sk-ant-x \n");
    expect(s.apiKey).toBe("sk-ant-x");
  });
});

describe("MCP client servers", () => {
  it("adds an enabled, empty HTTP server", () => {
    const s = fresh();
    s.mcpClientServers = [];
    addMcpServer(s);
    expect(s.mcpClientServers).toEqual([{ name: "", enabled: true, transport: "http", url: "", command: "", args: "" }]);
  });

  it("removes only the server at the index", () => {
    const s = fresh();
    s.mcpClientServers = [{ ...server(), name: "a" }, { ...server(), name: "b" }, { ...server(), name: "c" }];
    removeMcpServer(s, 1);
    expect(s.mcpClientServers.map((x) => x.name)).toEqual(["a", "c"]);
  });

  it("keeps name and args verbatim and trims url and command", () => {
    const x = server();
    editMcpServer(x, { field: "name", value: " My Server " });
    editMcpServer(x, { field: "args", value: " -y  pkg " });
    editMcpServer(x, { field: "url", value: "  https://example.test/mcp " });
    editMcpServer(x, { field: "command", value: " npx " });
    expect(x).toMatchObject({ name: " My Server ", args: " -y  pkg ", url: "https://example.test/mcp", command: "npx" });
  });

  it("sets enabled and transport", () => {
    const x = server();
    editMcpServer(x, { field: "enabled", value: false });
    editMcpServer(x, { field: "transport", value: "stdio" });
    expect(x).toMatchObject({ enabled: false, transport: "stdio" });
  });
});

describe("MCP bridge token", () => {
  it("mints a token when enabling with none resolved", () => {
    const s = fresh();
    s.mcpToken = "";
    setMcpEnabled(s, true, () => false, () => "minted");
    expect(s).toMatchObject({ mcpEnabled: true, mcpToken: "minted" });
  });

  it("keeps the stored token when one already resolves", () => {
    const s = fresh();
    s.mcpToken = "existing";
    setMcpEnabled(s, true, () => true, () => "minted");
    expect(s.mcpToken).toBe("existing");
  });

  it("never mints or resolves when disabling", () => {
    const s = fresh();
    s.mcpToken = "";
    let resolved = false;
    setMcpEnabled(s, false, () => { resolved = true; return false; }, () => "minted");
    expect(s).toMatchObject({ mcpEnabled: false, mcpToken: "" });
    expect(resolved).toBe(false);
  });

  it("regenerate replaces the stored token", () => {
    const s = fresh();
    s.mcpToken = "old";
    regenerateMcpToken(s, () => "new");
    expect(s.mcpToken).toBe("new");
  });
});

describe("selectEmbedding", () => {
  it("leaves the setting untouched when the value is unchanged", () => {
    const s = fresh();
    expect(selectEmbedding(s, { key: "embeddingEngine", value: s.embeddingEngine }, 5)).toEqual({ changed: false, rebuildLabel: null });
    expect(selectEmbedding(s, { key: "builtinEmbeddingModel", value: s.builtinEmbeddingModel }, 5)).toEqual({ changed: false, rebuildLabel: null });
    expect(s).toEqual(fresh());
  });

  it("labels an engine switch to built-in as the built-in model", () => {
    const s = fresh();
    s.embeddingEngine = "ollama";
    expect(selectEmbedding(s, { key: "embeddingEngine", value: "builtin" }, 3)).toEqual({ changed: true, rebuildLabel: "the built-in model" });
    expect(s.embeddingEngine).toBe("builtin");
  });

  it("labels an engine switch to another engine by its name", () => {
    const s = fresh();
    s.embeddingEngine = "builtin";
    expect(selectEmbedding(s, { key: "embeddingEngine", value: "ollama" }, 3)).toEqual({ changed: true, rebuildLabel: "ollama" });
    expect(s.embeddingEngine).toBe("ollama");
  });

  it("offers a rebuild when the index holds a single note", () => {
    expect(selectEmbedding(fresh(), { key: "embeddingEngine", value: "ollama" }, 1).rebuildLabel).toBe("ollama");
  });

  it("labels a model switch without the builtin prefix", () => {
    const s = fresh();
    s.builtinEmbeddingModel = "builtin:other";
    expect(selectEmbedding(s, { key: "builtinEmbeddingModel", value: "builtin:arctic-xs" }, 3)).toEqual({ changed: true, rebuildLabel: "arctic-xs" });
    expect(s.builtinEmbeddingModel).toBe("builtin:arctic-xs");
  });

  it("applies the switch without offering a rebuild when the index is empty", () => {
    const s = fresh();
    s.embeddingEngine = "builtin";
    s.builtinEmbeddingModel = "builtin:other";
    expect(selectEmbedding(s, { key: "embeddingEngine", value: "custom" }, 0)).toEqual({ changed: true, rebuildLabel: null });
    expect(selectEmbedding(s, { key: "builtinEmbeddingModel", value: "builtin:arctic-xs" }, 0)).toEqual({ changed: true, rebuildLabel: null });
    expect(s).toMatchObject({ embeddingEngine: "custom", builtinEmbeddingModel: "builtin:arctic-xs" });
  });
});

describe("cached model hint", () => {
  it("shows only when cached, idle, and no backend is loaded", () => {
    const clear = { cached: true, running: false, backendLoaded: false };
    expect(showCachedModelHint(clear)).toBe(true);
    expect(showCachedModelHint({ ...clear, cached: false })).toBe(false);
    expect(showCachedModelHint({ ...clear, running: true })).toBe(false);
    expect(showCachedModelHint({ ...clear, backendLoaded: true })).toBe(false);
  });

  it("words the hint per platform", () => {
    expect(cachedModelHint(true)).toBe("Model cached — choose Load or Rebuild index to start this session.");
    expect(cachedModelHint(false)).toBe("Model cached — loads on first use.");
  });
});

describe("canDeleteDeviceModel", () => {
  it("allows deletion only when idle", () => {
    expect(canDeleteDeviceModel({ chatBusy: false, downloading: false })).toBe(true);
    expect(canDeleteDeviceModel({ chatBusy: true, downloading: false })).toBe(false);
    expect(canDeleteDeviceModel({ chatBusy: false, downloading: true })).toBe(false);
  });
});

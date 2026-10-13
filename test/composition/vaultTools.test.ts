import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { enrichImportedResearchSource, memoryRecordDeps, vaultToolOptions, webToolImpls, zoteroLibrary, type VaultToolsHost } from "../../src/composition/vaultTools";
import { SEMANTIC_OFF_MESSAGE } from "../../src/mcp/vaultTools";

type Settings = Record<string, unknown>;

function rig(settings: Settings = {}) {
  const semantic = { semanticSearch: vi.fn(async () => ["hit"]), relatedForTools: vi.fn(async () => ["rel"]) };
  const registry = { id: "registry" };
  const enrichResearchSource = vi.fn();
  const getAbstractFileByPath = vi.fn();
  const host = {
    app: { vault: { getAbstractFileByPath } },
    settings: {
      mcpWriteFolder: "Claude/Inbox",
      semanticEnabled: true,
      ontologyFolder: "Ontology",
      zoteroUserId: "",
      zoteroApiKey: "",
      memoryRecordEnabled: true,
      memoryBaseTags: ["base"],
      webSearchEnabled: false,
      webFetchEnabled: false,
      webSearchEngine: "duckduckgo",
      braveSearchApiKey: "",
      ...settings,
    },
    semantic: () => semantic,
    ontology: () => registry,
    enrichment: () => ({ enrichResearchSource }),
    memoryNotePath: () => "Memory/What Claude Knows.md",
  } as unknown as VaultToolsHost;
  return { host, semantic, registry, enrichResearchSource, getAbstractFileByPath };
}

afterEach(() => vi.unstubAllGlobals());

describe("vaultToolOptions", () => {
  it("passes the write gate and folder through", () => {
    const { host } = rig();
    expect(vaultToolOptions(host, true).allowWrites).toBe(true);
    expect(vaultToolOptions(host, false).allowWrites).toBe(false);
    expect(vaultToolOptions(host, false).defaultFolder).toBe("Claude/Inbox");
  });

  it("passes the memory source into the memory record", () => {
    const { host } = rig();
    expect(vaultToolOptions(host, true, "companion").memoryRecord?.source).toBe("companion");
    expect(vaultToolOptions(host, true).memoryRecord).not.toHaveProperty("source");
  });

  it("routes semantic search and ontology reads to the host", async () => {
    const { host, semantic, registry } = rig({ ontologyFolder: "Onto" });
    const options = vaultToolOptions(host, true);
    const accept = () => true;
    await expect(options.semantic?.("q", 3, accept)).resolves.toEqual(["hit"]);
    expect(semantic.semanticSearch).toHaveBeenCalledWith("q", 3, accept);
    await expect(options.related?.("a.md", 4)).resolves.toEqual(["rel"]);
    expect(semantic.relatedForTools).toHaveBeenCalledWith("a.md", 4);
    expect(options.ontology?.()).toBe(registry);
    expect(options.ontologyFolder?.()).toBe("Onto");
  });

  it("related throws the semantic-off message when semantic is disabled", async () => {
    const { host, semantic } = rig({ semanticEnabled: false });
    await expect(vaultToolOptions(host, true).related?.("a.md", 4)).rejects.toThrow(SEMANTIC_OFF_MESSAGE);
    expect(semantic.relatedForTools).not.toHaveBeenCalled();
  });

  it("reads settings at call time", () => {
    const { host } = rig();
    const options = vaultToolOptions(host, true);
    (host.settings as unknown as Settings).zoteroUserId = "42";
    expect(options.zotero?.()).toEqual({ userId: "42" });
  });
});

describe("zoteroLibrary", () => {
  it("is undefined without a user id", () => {
    expect(zoteroLibrary(rig({ zoteroUserId: "  ", zoteroApiKey: "k" }).host)).toBeUndefined();
  });

  it("trims the api key and omits it when empty", () => {
    expect(zoteroLibrary(rig({ zoteroUserId: " 7 ", zoteroApiKey: " key " }).host)).toEqual({ userId: "7", apiKey: "key" });
    expect(zoteroLibrary(rig({ zoteroUserId: "7", zoteroApiKey: "  " }).host)).toEqual({ userId: "7" });
  });
});

describe("memoryRecordDeps", () => {
  it("reads the toggle, path and tags from the host", () => {
    const { host } = rig({ memoryRecordEnabled: false });
    const deps = memoryRecordDeps(host);
    expect(deps.enabled()).toBe(false);
    expect(deps.path()).toBe("Memory/What Claude Knows.md");
    expect(deps.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(deps.newNote("body")).toContain("base");
  });
});

describe("webToolImpls", () => {
  it("returns no tools when both are disabled", () => {
    expect(webToolImpls(rig().host)).toEqual({});
  });

  it("brave search without a key throws the settings hint", async () => {
    const { host } = rig({ webSearchEnabled: true, webSearchEngine: "brave", braveSearchApiKey: "  " });
    await expect(webToolImpls(host).webSearch?.("q", 3)).rejects.toThrow(
      "Brave Search needs an API key — add it in Companion settings → Agent, or switch to DuckDuckGo.",
    );
  });

  it("duckduckgo search needs a DOMParser", async () => {
    vi.stubGlobal("DOMParser", undefined);
    const { host } = rig({ webSearchEnabled: true });
    const impls = webToolImpls(host);
    expect(impls.webFetch).toBeUndefined();
    await expect(impls.webSearch?.("q", 3)).rejects.toThrow("Web search is unavailable in this environment.");
  });

  it("offers fetch only when enabled and a DOMParser exists", () => {
    const { host } = rig({ webFetchEnabled: true });
    vi.stubGlobal("DOMParser", undefined);
    expect(webToolImpls(host).webFetch).toBeUndefined();
    vi.stubGlobal("DOMParser", class {});
    expect(webToolImpls(host).webFetch).toBeTypeOf("function");
    expect(webToolImpls(host).webSearch).toBeUndefined();
  });
});

describe("enrichImportedResearchSource", () => {
  it("ignores paths that are not files", async () => {
    const { host, enrichResearchSource, getAbstractFileByPath } = rig();
    getAbstractFileByPath.mockReturnValue(null);
    await enrichImportedResearchSource(host, "missing.md");
    expect(enrichResearchSource).not.toHaveBeenCalled();
  });

  it("enriches the file with its metadata", async () => {
    const { host, enrichResearchSource, getAbstractFileByPath } = rig();
    getAbstractFileByPath.mockReturnValue(new TFile("Sources/a.md", "abc", 0));
    enrichResearchSource.mockResolvedValue({ status: "enriched" });
    await enrichImportedResearchSource(host, "Sources/a.md");
    expect(enrichResearchSource).toHaveBeenCalledWith({ path: "Sources/a.md", basename: "a", extension: "md", stat: { size: 3 } });
  });

  it("throws the failed outcome's error", async () => {
    const { host, enrichResearchSource, getAbstractFileByPath } = rig();
    getAbstractFileByPath.mockReturnValue(new TFile("Sources/a.md", "abc", 0));
    const error = new Error("enrich failed");
    enrichResearchSource.mockResolvedValue({ status: "failed", error });
    await expect(enrichImportedResearchSource(host, "Sources/a.md")).rejects.toBe(error);
  });
});

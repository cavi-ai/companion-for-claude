import { App, Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import { SemanticController } from "../src/semantic/controller";

function mobilePlugin(app: App): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(app.vault as unknown as Record<string, unknown>, {
    adapter: {
      exists: async () => false,
      read: async () => "",
      write: async () => undefined,
    },
  });
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app,
    manifest: { id: "claude-companion", dir: ".obsidian/plugins/claude-companion" },
    settings: { ...structuredClone(DEFAULT_SETTINGS), semanticEnabled: true, embeddingEngine: "builtin" },
    _indexer: null,
    indexerModel: null,
    builtinEmbedder: () => ({ embed: async (input: string[]) => input.map(() => [1]) }),
    canEmbedWithoutDownload: async () => true,
  });
  return plugin;
}

/** The built-in model is ready and embeds every input as one fixed vector. */
function embedsLocally(): void {
  vi.spyOn(SemanticController.prototype, "canEmbedWithoutDownload").mockResolvedValue(true);
  vi.spyOn(SemanticController.prototype, "builtinEmbedder").mockReturnValue({ embed: async (input: string[]) => input.map(() => [1]), backend: () => "wasm", terminate: () => undefined } as never);
}

const DIR = ".obsidian/plugins/claude-companion";
const SHARED = `${DIR}/semantic-index.json`;
const PHONE = `${DIR}/semantic-index-mobile.json`;

/** Index files on disk by path, with sizes; read and write are spies. Call after mobilePlugin, which resets the adapter. */
function indexFiles(app: App, files: Record<string, number>) {
  const read = vi.fn(async (_path: string) => "{}");
  const write = vi.fn(async (_path: string, _data: string) => undefined);
  Object.assign(app.vault.adapter, {
    exists: async (path: string) => path in files,
    stat: async (path: string) => (path in files ? { size: files[path] } : null),
    read,
    write,
  });
  return { read, write };
}

describe("mobile semantic index file", () => {
  it("never reads a desktop index over the mobile budget, and a rebuild writes the phone's own file", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    app.vault.seed("note.md", "A note about embeddings.");
    embedsLocally();
    const plugin = mobilePlugin(app);
    const { read, write } = indexFiles(app, { [SHARED]: 17_699_055 });
    const indexer = plugin.indexer()!;

    await expect(indexer.stats()).resolves.toEqual({ notes: 0, chunks: 0 });
    const result = await indexer.build({ force: true });

    expect(result.failures).toEqual([]);
    expect(result.indexed).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([path]) => path)).toEqual([PHONE]);
  });

  it("reads a shared index that fits the budget until the phone has its own", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    const plugin = mobilePlugin(app);
    const { read } = indexFiles(app, { [SHARED]: 1024 });
    await plugin.indexer()!.stats();
    expect(read.mock.calls.map(([path]) => path)).toEqual([SHARED]);
  });

  it("prefers the phone's own index", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    const plugin = mobilePlugin(app);
    const { read } = indexFiles(app, { [SHARED]: 1024, [PHONE]: 2048 });
    await plugin.indexer()!.stats();
    expect(read.mock.calls.map(([path]) => path)).toEqual([PHONE]);
  });

  it("starts empty when the index size cannot be read", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    const plugin = mobilePlugin(app);
    const { read } = indexFiles(app, { [SHARED]: 1024, [PHONE]: 2048 });
    Object.assign(app.vault.adapter, { stat: async () => null });
    await expect(plugin.indexer()!.stats()).resolves.toEqual({ notes: 0, chunks: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the desktop index file on desktop", async () => {
    const app = new App();
    app.vault.seed("note.md", "A note about embeddings.");
    embedsLocally();
    const plugin = mobilePlugin(app);
    const { read, write } = indexFiles(app, { [SHARED]: 17_699_055, [PHONE]: 2048 });
    await plugin.indexer()!.build({ force: true });
    expect(read.mock.calls.map(([path]) => path)).toEqual([SHARED]);
    expect(write.mock.calls.map(([path]) => path)).toEqual([SHARED]);
  });

  afterEach(() => {
    Platform.isMobile = false;
    Platform.isDesktop = true;
    vi.restoreAllMocks();
  });
});

describe("mobile semantic input limits", () => {
  afterEach(() => {
    Platform.isMobile = false;
    Platform.isDesktop = true;
    vi.restoreAllMocks();
  });

  it("rejects an oversized Markdown note before the mobile vault bridge reads it", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    const file = app.vault.seed("large.md", "small fixture");
    file.stat.size = (5 * 1024 * 1024) + 1;
    const read = vi.spyOn(app.vault, "cachedRead");

    const result = await mobilePlugin(app).indexer()!.build({ force: true });

    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ indexed: 0, skipped: 1, failureCount: 1 });
    expect(result.failures[0]?.message).toContain("exceeds the semantic indexing limit");
  });

  it("rejects an oversized PDF before the mobile vault bridge allocates it", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const app = new App();
    const file = app.vault.seed("large.pdf", "small fixture");
    file.stat.size = (10 * 1024 * 1024) + 1;
    const read = vi.spyOn(app.vault, "readBinary");

    const result = await mobilePlugin(app).indexer()!.build({ force: true });

    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ indexed: 0, skipped: 1, failureCount: 1 });
    expect(result.failures[0]?.message).toContain("exceeds the semantic indexing limit");
  });
});

import { App, Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";

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

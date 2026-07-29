import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  PluginSettingTab: class {},
}));

import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { EnrichDeps } from "../../src/sources/enrich";

interface PrivateEnrich {
  enrichDeps(): EnrichDeps;
}

function pluginHarness(complete: ReturnType<typeof vi.fn>): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS };
  Object.defineProperty(plugin, "router", {
    value: () => ({
      complete,
      resolve: () => ({ provider: { id: "ollama", label: "Local" }, model: "utility-model" }),
    }),
  });
  return plugin;
}

describe("source enrichment wiring", () => {
  it("routes extraction through JSON mode with thinking disabled and a larger budget", async () => {
    // Regression: enrichment sent free-form 1024-token completions, so a
    // thinking utility model exhausted the budget on hidden reasoning and
    // replied empty — ExtractError "reply was not valid JSON".
    const complete = vi.fn(async () => ({ text: "{}", provider: { id: "ollama" } }));
    const deps = (pluginHarness(complete) as unknown as PrivateEnrich).enrichDeps();
    await deps.complete("sys", "user", { maxTokens: 4096, responseSchema: { type: "object" }, disableThinking: true });
    expect(complete).toHaveBeenCalledWith("utility", expect.objectContaining({
      maxTokens: 4096,
      responseFormat: "json",
      responseSchema: { type: "object" },
      thinking: { type: "disabled" },
    }));
  });

  it("leaves the default completion shape untouched when no opts are given", async () => {
    const complete = vi.fn(async () => ({ text: "ok", provider: { id: "ollama" } }));
    const deps = (pluginHarness(complete) as unknown as PrivateEnrich).enrichDeps();
    await deps.complete("sys", "user");
    expect(complete).toHaveBeenCalledWith("utility", { system: "sys", user: "user" });
  });
});

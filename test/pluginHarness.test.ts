import { App } from "obsidian";
import { describe, expect, it } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import { buildPlugin } from "./fakes/plugin";

describe("plugin fixture", () => {
  it("builds the real class with fresh settings, manifest and app", () => {
    const app = new App();
    const plugin = buildPlugin({}, app);
    expect(plugin).toBeInstanceOf(ClaudeCompanionPlugin);
    expect(plugin.settings).not.toBe(DEFAULT_SETTINGS);
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(plugin.manifest.id).toBe("claude-companion");
    expect(plugin.app).toBe(app);
  });

});

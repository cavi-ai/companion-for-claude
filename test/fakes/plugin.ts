import { App } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";

export const TEST_MANIFEST = {
  id: "claude-companion",
  name: "Companion for Claude",
  version: "0.0.0-test",
  dir: ".obsidian/plugins/claude-companion",
} as const;

/** The real plugin class with its field initializers run; `overrides` are assigned on top (private fields included). */
export function buildPlugin(overrides: Record<string, unknown> = {}, app: App = new App()): ClaudeCompanionPlugin {
  const plugin = new ClaudeCompanionPlugin(app as never, TEST_MANIFEST as never);
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app,
    manifest: TEST_MANIFEST,
    settings: structuredClone(DEFAULT_SETTINGS),
    saveData: async () => undefined,
    ...overrides,
  });
  return plugin;
}

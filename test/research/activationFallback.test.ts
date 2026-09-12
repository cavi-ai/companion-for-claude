import { describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../../src/main";

function pluginWithNoRightLeaf() {
  const fallbackLeaf = {
    view: null,
    setViewState: vi.fn(async () => undefined),
  };
  const workspace = {
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getRightLeaf: vi.fn(() => null),
    getLeaf: vi.fn(() => fallbackLeaf),
    revealLeaf: vi.fn(async () => undefined),
  };
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, { app: { workspace } });
  return { plugin, workspace, fallbackLeaf };
}

describe("research view activation fallback", () => {
  it("creates and reveals a new leaf for Research Desk when no right leaf exists", async () => {
    const { plugin, workspace, fallbackLeaf } = pluginWithNoRightLeaf();

    await plugin.activateResearchDesk();

    expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
    expect(workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(fallbackLeaf.setViewState).toHaveBeenCalledWith({ type: "claude-research-desk", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(fallbackLeaf);
  });

  it("creates and reveals a new leaf for Research Workbench when no right leaf exists", async () => {
    const { plugin, workspace, fallbackLeaf } = pluginWithNoRightLeaf();

    await plugin.activateResearchWorkbench();

    expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
    expect(workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(fallbackLeaf.setViewState).toHaveBeenCalledWith({ type: "claude-research-workbench", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(fallbackLeaf);
  });
});

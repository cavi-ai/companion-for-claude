import { describe, expect, it, vi } from "vitest";
import { buildPlugin } from "../fakes/plugin";

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
  const plugin = buildPlugin({ app: { workspace } });
  return { plugin, workspace, fallbackLeaf };
}

describe("research view activation fallback", () => {
  it("creates and reveals a new leaf for Research Desk when no right leaf exists", async () => {
    const { plugin, workspace, fallbackLeaf } = pluginWithNoRightLeaf();

    await plugin.research().activateResearchDesk();

    expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
    expect(workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(fallbackLeaf.setViewState).toHaveBeenCalledWith({ type: "claude-research-desk", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(fallbackLeaf);
  });
});

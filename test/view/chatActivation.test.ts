import { Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../../src/main";
import { CHAT_VIEW_TYPE, ChatView } from "../../src/view/ChatView";

function chatLeaf(parent: unknown = undefined): {
  parent?: unknown;
  view: ChatView;
  setViewState: ReturnType<typeof vi.fn>;
} {
  return {
    parent,
    view: Object.create(ChatView.prototype) as ChatView,
    setViewState: vi.fn(async () => undefined),
  };
}

function pluginForWorkspace(workspace: Record<string, unknown>): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, { app: { workspace } });
  return plugin;
}

describe("Chat view activation", () => {
  afterEach(() => {
    Platform.isMobile = false;
  });

  it("opens mobile Chat in one main tab instead of reusing the right sidebar", async () => {
    Platform.isMobile = true;
    const rightSidebar = {};
    const sidebarChat = chatLeaf(rightSidebar);
    const mainChat = chatLeaf({});
    const workspace = {
      rightSplit: rightSidebar,
      getLeavesOfType: vi.fn(() => [sidebarChat]),
      getRightLeaf: vi.fn(() => sidebarChat),
      getLeaf: vi.fn(() => mainChat),
      revealLeaf: vi.fn(async () => undefined),
    };
    const plugin = pluginForWorkspace(workspace);

    const first = await plugin.activateView();
    expect(first).toBe(mainChat.view);
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(mainChat.setViewState).toHaveBeenCalledWith({ type: CHAT_VIEW_TYPE, active: true });

    workspace.getLeavesOfType.mockReturnValue([sidebarChat, mainChat]);
    const second = await plugin.activateView();

    expect(second).toBe(mainChat.view);
    expect(workspace.getLeaf).toHaveBeenCalledTimes(1);
    expect(mainChat.setViewState).toHaveBeenCalledTimes(1);
    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(1, mainChat);
    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(2, mainChat);
  });

  it("keeps desktop Chat activation in the right sidebar", async () => {
    const sidebarChat = chatLeaf({});
    const workspace = {
      rightSplit: {},
      getLeavesOfType: vi.fn(() => []),
      getRightLeaf: vi.fn(() => sidebarChat),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => undefined),
    };

    await pluginForWorkspace(workspace).activateView();

    expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(sidebarChat.setViewState).toHaveBeenCalledWith({ type: CHAT_VIEW_TYPE, active: true });
  });
});

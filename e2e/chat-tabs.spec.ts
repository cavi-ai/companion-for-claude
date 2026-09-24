import { expect, test } from "./fixtures";
import { launchObsidianHarness } from "./obsidianHarness";

/** Switch the visible Chat tab to the leaf at `index` among all Chat leaves, in DOM/creation order. */
async function focusChatLeaf(page: import("@playwright/test").Page, index: number): Promise<void> {
  await page.evaluate(async (i) => {
    const app = (window as unknown as {
      app: { workspace: { getLeavesOfType(type: string): unknown[]; revealLeaf(leaf: unknown): Promise<void>; setActiveLeaf(leaf: unknown, params?: { focus?: boolean }): void } };
    }).app;
    const leaves = app.workspace.getLeavesOfType("claude-companion-chat");
    const leaf = leaves[i];
    if (leaf) {
      await app.workspace.revealLeaf(leaf);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }
  }, index);
}

/** The conversation id of the currently active Chat leaf, per its own getState() — never assume DOM order. */
async function activeChatConversationId(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() =>
    (window as unknown as {
      app: { workspace: { activeLeaf: { view?: { getState?(): { conversationId: string | null } } } | null } };
    }).app.workspace.activeLeaf?.view?.getState?.()?.conversationId ?? null,
  );
}

test("running New chat tab twice opens two leaves that stream independent conversations", async () => {
  const harness = await launchObsidianHarness({ claudeCli: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:new-chat-tab");
      await app.commands.executeCommandById("claude-companion:new-chat-tab");
    });

    const leafCount = await page.evaluate(() =>
      (window as unknown as { app: { workspace: { getLeavesOfType(type: string): unknown[] } } }).app.workspace
        .getLeavesOfType("claude-companion-chat").length,
    );
    expect(leafCount).toBe(2);

    // Send "ping" in the first tab and wait for the reply.
    await focusChatLeaf(page, 0);
    expect(await activeChatConversationId(page)).toBeNull(); // fresh tab, no turn started yet
    const chat = page.locator(".cc-chat-root:visible").first();
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    await chat.locator(".cc-input").fill("ping");
    await chat.locator(".cc-input").press("Enter");
    await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
    const firstConversationId = await activeChatConversationId(page);
    expect(firstConversationId).not.toBeNull();

    // Switch to the second tab — a fresh, empty conversation — and do the same.
    await focusChatLeaf(page, 1);
    expect(await activeChatConversationId(page)).toBeNull(); // fresh tab, no turn started yet
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    await expect(chat.locator(".cc-msg")).toHaveCount(0);
    await chat.locator(".cc-input").fill("ping");
    await chat.locator(".cc-input").press("Enter");
    await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
    const secondConversationId = await activeChatConversationId(page);
    expect(secondConversationId).not.toBeNull();
    expect(secondConversationId).not.toBe(firstConversationId);

    const conversationIds = await page.evaluate(() =>
      (window as unknown as {
        app: { workspace: { getLeavesOfType(type: string): { view: { getState(): { conversationId: string | null } } }[] } };
      }).app.workspace.getLeavesOfType("claude-companion-chat").map((leaf) => leaf.view.getState().conversationId),
    );
    expect(conversationIds).toHaveLength(2);
    expect(conversationIds[0]).not.toBeNull();
    expect(conversationIds[1]).not.toBeNull();
    expect(conversationIds[0]).not.toBe(conversationIds[1]);
  } finally {
    await harness.close();
  }
});

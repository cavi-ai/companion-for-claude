import { expect, test } from "./fixtures";

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

test("running New chat tab twice opens two leaves that stream independent conversations", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const { page } = harness;
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:new-chat-tab");
    await app.commands.executeCommandById("claude-companion:new-chat-tab");
  });

  // Each Chat leaf renders its own root, only the active one visible — two tabs means two roots in the DOM.
  await expect(page.locator(".cc-chat-root")).toHaveCount(2);

  // Send "ping" in the first tab and wait for the reply.
  await focusChatLeaf(page, 0);
  const first = page.locator(".cc-chat-root:visible").first();
  await expect(first).toContainText("● Claude Code", { timeout: 15_000 });
  await expect(first.locator(".cc-msg")).toHaveCount(0); // fresh tab, nothing sent yet
  await first.locator(".cc-input").fill("ping");
  await first.locator(".cc-input").press("Enter");
  await expect(first.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
  await expect(first.locator(".cc-msg")).toHaveCount(2);

  // Switch to the second tab — a fresh, empty conversation, unaffected by the first — and do the same.
  await focusChatLeaf(page, 1);
  const second = page.locator(".cc-chat-root:visible").first();
  await expect(second).toContainText("● Claude Code", { timeout: 15_000 });
  await expect(second.locator(".cc-msg")).toHaveCount(0);
  await second.locator(".cc-input").fill("ping");
  await second.locator(".cc-input").press("Enter");
  await expect(second.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
  await expect(second.locator(".cc-msg")).toHaveCount(2);

  // Switching back proves the first tab's own transcript was never touched by the second's turn.
  await focusChatLeaf(page, 0);
  const backToFirst = page.locator(".cc-chat-root:visible").first();
  await expect(backToFirst.locator(".cc-msg")).toHaveCount(2);
  await expect(backToFirst.locator(".cc-msg.cc-user").first()).toContainText("ping");
});

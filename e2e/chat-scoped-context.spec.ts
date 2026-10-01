import { expect, test } from "./fixtures";

async function focusChatLeaf(page: import("@playwright/test").Page, index: number): Promise<void> {
  await page.evaluate(async (i) => {
    const app = (window as unknown as {
      app: { workspace: { getLeavesOfType(type: string): unknown[]; revealLeaf(leaf: unknown): Promise<void>; setActiveLeaf(leaf: unknown, params?: { focus?: boolean }): void } };
    }).app;
    const leaf = app.workspace.getLeavesOfType("claude-companion-chat")[i];
    if (leaf) {
      await app.workspace.revealLeaf(leaf);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }
  }, index);
}

test("@vault in one chat tab leaves the other tab and the stored default off", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true });
  await page.evaluate(async () => {
    const app = (window as unknown as {
      app: {
        plugins: { plugins: Record<string, { settings: { context: Record<string, boolean> } }> };
        commands: { executeCommandById(id: string): Promise<void> };
      };
    }).app;
    app.plugins.plugins["claude-companion"]!.settings.context = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
    await app.commands.executeCommandById("claude-companion:new-chat-tab");
    await app.commands.executeCommandById("claude-companion:new-chat-tab");
  });
  await expect(page.locator(".cc-chat-root")).toHaveCount(2);

  await focusChatLeaf(page, 0);
  const first = page.locator(".cc-chat-root:visible").first();
  // Keyboard choose: hovering an @ row re-renders the list and detaches it mid-click.
  await first.locator(".cc-input").fill("@entire");
  await expect(first.locator(".cc-at-item.is-selected")).toContainText("Entire vault");
  await first.locator(".cc-input").press("Enter");
  await expect(first.getByRole("button", { name: /^Manage context, 1 item active/ })).toBeVisible();

  await focusChatLeaf(page, 1);
  const second = page.locator(".cc-chat-root:visible").first();
  await expect(second.getByRole("button", { name: /^Manage context, 0 items active/ })).toBeVisible();

  const stored = await page.evaluate(() => (window as unknown as {
    app: { plugins: { plugins: Record<string, { settings: { context: { searchVault: boolean } } }> } };
  }).app.plugins.plugins["claude-companion"]!.settings.context.searchVault);
  expect(stored).toBe(false);
});

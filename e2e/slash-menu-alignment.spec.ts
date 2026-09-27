import { expect, test } from "./fixtures";

test("slash commands align at the left and keep extended commands searchable", async ({ rig }) => {
  const harness = await rig.reset();
  try {
    await harness.page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = harness.page.locator(".cc-chat-root");
    const input = chat.locator("textarea");
    await input.fill("/");
    const menu = chat.locator(".cc-slash-menu:not(.cc-at-menu)");
    await expect(menu).toBeVisible();
    const names = menu.locator(".cc-slash-name");
    const positions = await names.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
    expect(positions.length).toBeGreaterThan(5);
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
    await expect(menu.getByRole("button", { name: /\/manifest-vault/i })).toHaveCount(0);

    await input.fill("/manifest-vault");
    await expect(menu.getByRole("button", { name: /\/manifest-vault/i })).toBeVisible();
  } finally {
    await harness.close();
  }
});

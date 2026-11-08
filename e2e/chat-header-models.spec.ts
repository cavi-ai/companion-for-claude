import { expect, test } from "./fixtures";

test("model picker separates backends and preserves the chosen route", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true, settingsOverride: { model: "claude-sonnet-5-5" } });
  try {
    await harness.page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const header = harness.page.locator(".cc-chat-root .cc-header");
    const chip = header.locator(".cc-model");
    await expect(chip).toHaveJSProperty("tagName", "BUTTON");
    await expect(chip.locator("button")).toHaveCount(0);
    await expect(header.locator(".cc-model-backend")).toContainText("Claude Code");
    await expect(header.getByRole("button", { name: "Sessions", exact: true })).toBeVisible();
    await chip.click();
    const chooser = harness.page.locator(".cc-model-picker");
    const claude = chooser.locator('[data-backend="claude"]');
    await expect(claude.getByText("Claude Opus 5.5", { exact: true })).toBeVisible();
    await expect(claude.getByText("Claude Opus 4.6", { exact: true })).toBeVisible();
    await expect(claude.getByText("Claude Fable 5.1", { exact: true })).toBeVisible();
    await expect(claude.getByText("Claude Sonnet 5.5", { exact: true })).toBeVisible();
    await expect(chooser.getByText("Claude Sonnet 5", { exact: true })).toHaveCount(0);
    await expect(chooser.getByText("Claude Opus 5", { exact: true })).toHaveCount(0);
    await expect(chooser.getByText("Claude Fable 5", { exact: true })).toHaveCount(0);
    await expect(chooser.getByRole("button", { name: "Configure models…", exact: true })).toBeVisible();
    await chooser.locator(`[data-model-value="claude:claude-sonnet-5-5"]`).click();
    await expect(header.locator(".cc-model-backend")).toHaveText("API");
    await chip.click();
    await chooser.locator(`[data-model-value="claude-cli:claude-sonnet-5-5"]`).click();
    await expect(header.locator(".cc-model-backend")).toHaveText("Claude Code");

  } finally {
    await harness.close();
  }
});

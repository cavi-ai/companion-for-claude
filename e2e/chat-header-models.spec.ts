import { expect, test } from "./fixtures";

test("model chip aligns with the backend pill and offers the curated models", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true, settingsOverride: { model: "claude-sonnet-5" } });
  try {
    await harness.page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const header = harness.page.locator(".cc-chat-root .cc-header");
    const chip = header.locator(".cc-model");
    const modelText = chip.locator(".cc-model-text");
    const pill = header.locator(".cc-backend-pill");
    await expect(pill).toContainText("Claude Code");
    const [textBox, pillBox] = await Promise.all([modelText.boundingBox(), pill.boundingBox()]);
    expect(textBox && pillBox).toBeTruthy();
    expect(Math.abs(textBox!.x - pillBox!.x)).toBeLessThanOrEqual(1);

    await chip.click();
    const chooser = harness.page.locator(".cc-action-sheet");
    await expect(chooser.getByText("Claude Opus 5.5", { exact: true })).toBeVisible();
    await expect(chooser.getByText("Claude Opus 4.6", { exact: true })).toBeVisible();
    await expect(chooser.getByText("Claude Fable 5.1", { exact: true })).toBeVisible();
    await expect(chooser.getByText("Claude Opus 5", { exact: true })).toHaveCount(0);
    await expect(chooser.getByText("Claude Fable 5", { exact: true })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

test("ephemeral Companion feedback appears immediately and clears within 2.5 seconds", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const plan = page.getByLabel("Plan Mode — Claude explores your vault read-only and proposes a plan before changing anything");
    await expect(plan).toBeVisible();

    const started = Date.now();
    await plan.click();
    const notice = page.locator(".notice").filter({ hasText: "Plan Mode: on" });
    await expect(notice).toBeVisible({ timeout: 500 });
    expect(Date.now() - started).toBeLessThan(500);
    await expect(notice).toBeHidden({ timeout: 2_500 });
    expect(Date.now() - started).toBeLessThan(2_500);
  } finally {
    await harness.close();
  }
});

import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

test("Desktop integrations opens through Obsidian's real Node runtime boundary", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  try {
    await page.evaluate(() => {
      const app = (window as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
      app.setting.open();
      app.setting.openTabById("claude-companion");
    });

    const settings = page.locator(".vertical-tab-content");
    const open = settings.getByRole("button", { name: "Desktop integrations", exact: true });
    await expect(open).toBeVisible();
    await open.click();

    const modal = page.locator(".cc-desktop-integrations-modal");
    await page.waitForTimeout(250);
    const notices = await page.locator(".notice").allTextContents();
    expect(await modal.count(), `notices: ${notices.join(" | ")}`).toBeGreaterThan(0);
    await expect(modal).toBeVisible();
    await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

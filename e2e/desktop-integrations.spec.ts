import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

test("Desktop integrations opens through Obsidian's real Node runtime boundary", async () => {
  const harness = await launchObsidianHarness();
  try {
    // Settings is its own window on Obsidian 1.13+, and the modal mounts in
    // whichever window owns the control that opened it.
    const settingsPage = await harness.openSettings();

    const settings = settingsPage.locator(".vertical-tab-content");
    const open = settings.getByRole("button", { name: "Desktop integrations", exact: true });
    await expect(open).toBeVisible();
    await open.click();

    const modal = settingsPage.locator(".cc-desktop-integrations-modal");
    await settingsPage.waitForTimeout(250);
    const notices = await settingsPage.locator(".notice").allTextContents();
    expect(await modal.count(), `notices: ${notices.join(" | ")}`).toBeGreaterThan(0);
    await expect(modal).toBeVisible();
    await expect(settingsPage.getByText("Claude Code", { exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

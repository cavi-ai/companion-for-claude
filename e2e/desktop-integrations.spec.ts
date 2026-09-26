import { expect, test } from "./fixtures";

test("Desktop integrations opens through Obsidian's real Node runtime boundary", async ({ rig }) => {
  const harness = await rig.reset();
  try {
    // Settings is its own window on Obsidian 1.13+, and the modal mounts in
    // whichever window owns the control that opened it.
    const settingsPage = await harness.openSettings();

    const settings = settingsPage.locator(".vertical-tab-content");
    const open = settings.getByRole("button", { name: "Set up", exact: true });
    await expect(open).toBeVisible();
    await open.click();

    const modal = settingsPage.locator(".cc-desktop-integrations-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByRole("heading", { name: "Claude Code" })).toBeVisible();
  } finally {
    await harness.close();
  }
});

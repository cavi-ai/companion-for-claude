import { expect, openSettingsSection, test } from "./fixtures";

test("Desktop integrations opens through Obsidian's real Node runtime boundary", async ({ rig }, testInfo) => {
  const harness = await rig.reset();
  try {
    // Settings is its own window on Obsidian 1.13+, and the modal mounts in
    // whichever window owns the control that opened it.
    const settingsPage = await openSettingsSection(harness, "Desktop integrations");

    const settings = settingsPage.locator(".vertical-tab-content");
    const open = settings.getByRole("button", { name: "Set up", exact: true });
    await expect(open).toBeVisible();
    await open.click();

    const modal = settingsPage.locator(".cc-desktop-integrations-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByRole("heading", { name: "Claude Code" })).toBeVisible();
    // The agent CLIs are checked through the same Node boundary: each one gets a state line, installed or not.
    await expect(modal.getByRole("heading", { name: "Codex and Antigravity" })).toBeVisible();
    await expect(modal.getByText(/^Codex: /)).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText(/^Antigravity: /)).toBeVisible();
    await modal.getByRole("heading", { name: "Codex and Antigravity" }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
    await settingsPage.screenshot({ path: testInfo.outputPath("desktop-integrations-agent-clis.png") });
  } finally {
    await harness.close();
  }
});

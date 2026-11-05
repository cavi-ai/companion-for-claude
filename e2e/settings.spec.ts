import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { Rig } from "./fixtures";

async function openSettingsTab(harness: Rig): Promise<Locator> {
  const page = await harness.openSettings();
  await page.setViewportSize({ width: 900, height: 785 });
  const tab = page.locator(".vertical-tab-content-container .vertical-tab-content").last();
  await expect(tab.getByRole("heading", { name: "Companion settings", exact: true })).toBeVisible();
  return tab;
}

for (const [layout, width, theme] of [["desktop", 675, "dark"], ["narrow", 350, "light"]] as const) {
  test(`long model selectors preserve readable descriptions in the ${layout} layout`, async ({ rig }) => {
    const harness = await rig.reset({ settingsOverride: { setupWizardDone: true, semanticEnabled: true, embeddingEngine: "builtin" }, theme });
    try {
      const tab = await openSettingsTab(harness);
      await tab.evaluate((element, paneWidth) => { element.style.width = `${paneWidth}px`; element.style.maxWidth = `${paneWidth}px`; }, width);
      await tab.getByRole("button", { name: "Capture & search", exact: true }).click();
      const row = tab.locator('.setting-item:has(.setting-item-name:text-is("Built-in model"))');
      await expect(row).toBeVisible();
      await row.screenshot({ path: test.info().outputPath(`built-in-model-${theme}.png`) });
      const bounds = await row.evaluate((element) => {
        const rowRect = element.getBoundingClientRect();
        const info = element.querySelector(".setting-item-info")!.getBoundingClientRect();
        const control = element.querySelector(".setting-item-control")!.getBoundingClientRect();
        const select = element.querySelector("select:not(.is-measuring)")!.getBoundingClientRect();
        const style = getComputedStyle(element);
        const available = rowRect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { available, infoWidth: info.width, infoRight: info.right, infoBottom: info.bottom, controlLeft: control.left, controlTop: control.top, selectWidth: select.width, controlWidth: control.width, overflow: element.scrollWidth - element.clientWidth };
      });
      expect(bounds.infoWidth).toBeGreaterThanOrEqual(Math.min(240, bounds.available) - 1);
      const stacked = bounds.controlTop >= bounds.infoBottom - 1;
      const separateColumns = bounds.controlLeft >= bounds.infoRight + 12;
      expect(stacked || separateColumns, "description and selector must not overlap").toBe(true);
      if (layout === "narrow") expect(stacked).toBe(true);
      expect(bounds.selectWidth).toBeLessThanOrEqual(bounds.controlWidth + 1);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
    } finally { await harness.close(); }
  });
}

test("settings expose controls directly, persist edits and return from search", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { agentAllowWrites: false }, theme: "dark" });
  try {
    const tab = await openSettingsTab(harness);
    await expect(tab.getByLabel("Anthropic API key", { exact: true })).toBeVisible();
    await tab.getByRole("button", { name: "Vault access", exact: true }).click();
    const writes = tab.locator('.setting-item:has(.setting-item-name:text-is("Create and edit notes")) .checkbox-container');
    await writes.click(); await expect(writes).toHaveClass(/is-enabled/);
    await tab.getByRole("searchbox", { name: "Search all settings" }).fill("Max response tokens");
    const tokens = tab.locator('.setting-item:has(.setting-item-name:text-is("Max response tokens")) input');
    await tokens.fill("2048"); await tokens.blur();
    await tab.getByRole("button", { name: "Back", exact: true }).click();
    await expect(writes).toHaveClass(/is-enabled/);
    await harness.reloadPlugin();
    const reopened = await openSettingsTab(harness);
    await reopened.getByRole("searchbox", { name: "Search all settings" }).fill("Max response tokens");
    await expect(reopened.locator('.setting-item:has(.setting-item-name:text-is("Max response tokens")) input')).toHaveValue("2048");
    await reopened.getByRole("searchbox", { name: "Search all settings" }).fill("agentAllowWrites");
    await expect(reopened.locator(".checkbox-container")).toHaveClass(/is-enabled/);
  } finally { await harness.close(); }
});

test("settings navigation remains visible and fits a narrow pane in light theme", async ({ rig }) => {
  const harness = await rig.reset({ theme: "light" });
  try {
    const tab = await openSettingsTab(harness);
    await tab.evaluate((element) => { element.style.width = "350px"; element.style.maxWidth = "350px"; });
    const nav = tab.getByRole("navigation", { name: "Settings categories" });
    for (const category of ["Chat & models", "Vault access", "Capture & search", "Connections", "Files & privacy"]) {
      await nav.getByRole("button", { name: category, exact: true }).click();
      await expect(nav.getByRole("button", { name: category, exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(await tab.locator(".cc-settings-browser").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    await tab.screenshot({ path: test.info().outputPath("settings-narrow-light.png") });
  } finally { await harness.close(); }
});

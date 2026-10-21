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

async function expectAlignedDisclosureRows(tab: Locator): Promise<void> {
  const rows = await tab.locator(".cc-settings-disclosure").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    const label = button.firstElementChild!.getBoundingClientRect();
    const icon = button.lastElementChild!.getBoundingClientRect();
    return { label: button.textContent?.trim(), edgeLeft: bounds.left, edgeRight: bounds.right, left: label.left - bounds.left, right: bounds.right - icon.right, centerOffset: Math.abs((label.top + label.bottom - icon.top - icon.bottom) / 2) };
  }));
  const heading = await tab.locator(".cc-settings-category-title h2").boundingBox();
  expect(heading).not.toBeNull();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Math.abs(row.edgeLeft - heading!.x), row.label).toBeLessThanOrEqual(1);
    expect(Math.abs(row.edgeRight - heading!.x - heading!.width), row.label).toBeLessThanOrEqual(1);
    expect(row.left, row.label).toBeGreaterThanOrEqual(12);
    expect(row.right, row.label).toBeGreaterThanOrEqual(12);
    expect(Math.abs(row.left - row.right), row.label).toBeLessThanOrEqual(1);
    expect(row.centerOffset, row.label).toBeLessThanOrEqual(1);
  }
}

for (const [layout, width, theme] of [["desktop", 675, "dark"], ["narrow", 350, "light"]] as const) {
  test(`long model selectors preserve readable descriptions in the ${layout} layout`, async ({ rig }) => {
    const harness = await rig.reset({ settingsOverride: { setupWizardDone: true, semanticEnabled: true, embeddingEngine: "builtin" }, theme });
    try {
      const tab = await openSettingsTab(harness);
      await tab.evaluate((element, paneWidth) => { element.style.width = `${paneWidth}px`; element.style.maxWidth = `${paneWidth}px`; }, width);
      await tab.getByRole("button", { name: /Advanced settings/ }).click();
      await tab.getByRole("button", { name: "Capture & search", exact: true }).click();
      await tab.getByRole("button", { name: "Semantic search", exact: true }).click();
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

test("everyday settings and advanced controls share persisted values", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { setupWizardDone: true, agentAllowWrites: false }, theme: "dark" });
  const errors: string[] = [];
  const onError = (error: Error): void => { errors.push(String(error)); };
  harness.page.on("pageerror", onError);
  try {
    const tab = await openSettingsTab(harness);
    await expect(tab.getByRole("button", { name: /Choose how I chat/ })).toBeVisible();
    await expect(tab.getByText("Show advanced settings", { exact: true })).toHaveCount(0);
    await expect(tab.locator("input[type='password']")).toHaveCount(0);
    await tab.screenshot({ path: test.info().outputPath("everyday-dark.png") });
    await tab.getByRole("button", { name: /Choose how I chat/ }).click();
    const auth = tab.locator('.setting-item:has(.setting-item-name:text-is("Authentication")) select:not(.is-measuring)');
    await auth.selectOption("oauthToken");
    await expect(tab.locator("input[placeholder*='sk-ant-oat']")).toBeVisible();
    await auth.selectOption("apiKey");
    await expect(tab.locator("input[placeholder*='sk-ant-api']")).toBeVisible();
    await tab.getByRole("button", { name: "Everyday settings", exact: true }).click();
    await tab.getByRole("button", { name: /Control access to my notes/ }).click();
    const writes = tab.locator('.setting-item:has(.setting-item-name:text-is("Create and edit notes")) .checkbox-container');
    await writes.click();
    await expect(writes).toHaveClass(/is-enabled/);
    await tab.getByRole("button", { name: /More vault access settings/ }).click();
    await expect(tab.getByRole("heading", { name: "Vault access", exact: true })).toBeFocused();
    await expect(writes).toHaveClass(/is-enabled/);
    await expect(tab.getByRole("navigation", { name: "Settings categories" })).toBeVisible();
    await expect(tab.getByRole("button", { name: "Agent behavior", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expectAlignedDisclosureRows(tab);
    await tab.screenshot({ path: test.info().outputPath("advanced-dark.png") });
    await tab.getByRole("button", { name: "Agent behavior", exact: true }).click();
    await expect(tab.getByText("Max tool iterations per turn", { exact: true })).toBeVisible();
    await tab.getByRole("searchbox", { name: "Search all settings" }).fill("Max response tokens");
    const maxTokens = tab.locator(".setting-item", { hasText: "Max response tokens" }).locator("input");
    await maxTokens.fill("2048");
    await maxTokens.blur();
    await harness.reloadPlugin();
    const reopened = await openSettingsTab(harness);
    await reopened.getByRole("searchbox", { name: "Search all settings" }).fill("Max response tokens");
    await expect(reopened.locator(".setting-item", { hasText: "Max response tokens" }).locator("input")).toHaveValue("2048");
    await reopened.getByRole("searchbox", { name: "Search all settings" }).fill("agentAllowWrites");
    await expect(reopened.locator(".checkbox-container")).toHaveClass(/is-enabled/);
    expect(errors).toEqual([]);
  } finally { harness.page.off("pageerror", onError); await harness.close(); }
});

test("the settings home links the open-source repository", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { setupWizardDone: true }, theme: "dark" });
  try {
    const tab = await openSettingsTab(harness);
    const footer = tab.locator(".cc-settings-open-source");
    await expect(footer.getByRole("link", { name: "Star on GitHub", exact: true })).toHaveAttribute("href", "https://github.com/cavi-ai/companion-for-claude");
    await expect(footer.getByRole("link", { name: "Report an issue", exact: true })).toHaveAttribute("href", "https://github.com/cavi-ai/companion-for-claude/issues");
    await tab.screenshot({ path: test.info().outputPath("settings-home-open-source.png") });
  } finally { await harness.close(); }
});

test("the first-time shortcut opens the existing setup wizard", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { setupWizardDone: true }, theme: "dark" });
  try {
    await harness.page.evaluate(async () => {
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: { setupWizardDone: boolean; desktopIntegrationsOffered: boolean }; saveSettings(): Promise<void> }> } } }).app.plugins.plugins["claude-companion"]!;
      plugin.settings.setupWizardDone = false;
      plugin.settings.desktopIntegrationsOffered = false;
      await plugin.saveSettings();
    });
    const tab = await openSettingsTab(harness);
    await expect(tab.getByRole("button", { name: "Get started", exact: true })).toBeVisible();
    await tab.screenshot({ path: test.info().outputPath("first-time-dark.png") });
    await tab.getByRole("button", { name: "Get started", exact: true }).click();
    await expect.poll(async () => (await Promise.all(harness.windows().map((page) => page.getByText("Set up Claude Companion", { exact: true }).isVisible()))).some(Boolean)).toBe(true);
  } finally { await harness.close(); }
});

test("connection tasks distinguish vault access from external tools", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { setupWizardDone: true }, theme: "dark" });
  try {
    const tab = await openSettingsTab(harness);
    await tab.getByRole("button", { name: /Connect apps & tools/ }).click();
    await expect(tab.getByRole("heading", { name: "Use this vault in another app" })).toBeVisible();
    await expect(tab.getByRole("heading", { name: "Add tools to chat" })).toBeVisible();
    await expect(tab.getByText("You'll confirm every external tool call.", { exact: true })).toBeVisible();
    await tab.screenshot({ path: test.info().outputPath("connections-dark.png") });
    await tab.getByRole("button", { name: /Cloud sessions/ }).click();
    await expect(tab.getByText(/this sends your prompt \+ attached note context/)).toBeVisible();
    await tab.getByRole("button", { name: "Back to connections", exact: true }).click();
    await tab.getByRole("button", { name: "Add tool server", exact: true }).click();
    await expect(tab.getByText("External tools", { exact: true })).toBeVisible();
  } finally { await harness.close(); }
});

test("settings categories remain usable in a narrow pane and light theme", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { setupWizardDone: true }, theme: "light" });
  try {
    const tab = await openSettingsTab(harness);
    await tab.evaluate((el) => { el.style.width = "350px"; el.style.maxWidth = "350px"; });
    await tab.getByRole("button", { name: /Advanced settings/ }).click();
    await tab.getByRole("button", { name: "Chat & models", exact: true }).click();
    await expect(tab.getByText("Authentication", { exact: true })).toBeVisible();
    await expectAlignedDisclosureRows(tab);
    const nav = tab.getByRole("navigation", { name: "Settings categories" });
    const widths = await nav.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    await nav.getByRole("button", { name: "Files & privacy", exact: true }).click();
    const selected = nav.getByRole("button", { name: "Files & privacy", exact: true });
    await expect(selected).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: "Chat & models", exact: true }).hover();
    const selectedBackground = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
    await selected.hover();
    expect(await selected.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(selectedBackground);
    await tab.getByRole("searchbox", { name: "Search all settings" }).hover();
    const overflow = await tab.locator(".cc-settings-browser").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await tab.screenshot({ path: test.info().outputPath("advanced-narrow-light.png") });
    await nav.screenshot({ path: test.info().outputPath("category-navigation-light.png") });
  } finally { await harness.close(); }
});

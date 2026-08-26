import { test, expect, type Locator } from "@playwright/test";
import { launchObsidianHarness, type ObsidianHarness } from "./obsidianHarness";

// Settings-tab regression suite. Since 0.27.1 the tab is declarative
// (getSettingDefinitions), so Obsidian owns the group/page chrome and this
// suite asserts only renderer-independent behaviour: the rows render, the
// controls respond, and a visibility predicate swaps a dependent row. The
// shape of the definition tree itself is covered by test/settingsTabRender.

async function openSettingsTab(harness: ObsidianHarness): Promise<Locator> {
  const settingsPage = await harness.openSettings();
  const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
  await expect(tab).toBeVisible();
  // Intro rows are conditional (credential callouts), so the first row in DOM
  // order can legitimately be hidden — assert on the first rendered one.
  await expect(tab.locator(".setting-item:visible").first()).toBeVisible();
  return tab;
}

test("settings tab renders, controls respond, dependent rows follow", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  try {
    const tab = await openSettingsTab(harness);

    expect(await tab.locator(".setting-item").count()).toBeGreaterThan(10);
    expect(
      await tab
        .locator(".setting-item-control input, .setting-item-control select, .setting-item-control textarea, .setting-item-control .checkbox-container")
        .count(),
    ).toBeGreaterThan(5);
    await expect(tab.locator("button", { hasText: "Desktop integrations" })).toBeVisible();

    // Authentication is a control definition; its value gates which credential
    // row is visible, so switching it must swap the field in place.
    // Obsidian 1.13 mounts a hidden `select.is-measuring` twin beside every
    // dropdown to size it; only the real control is addressable.
    const auth = tab.locator(".setting-item", { hasText: "Authentication" }).locator("select:not(.is-measuring)");
    await auth.selectOption("oauthToken");
    await expect(tab.locator("input[type='password'][placeholder*='sk-ant-oat']")).toBeVisible();
    await auth.selectOption("apiKey");
    await expect(tab.locator("input[type='password'][placeholder*='sk-ant-api']")).toBeVisible();

    // A toggle round-trips and persists.
    const maxTokens = tab.locator(".setting-item", { hasText: "Max response tokens" }).locator("input");
    await expect(maxTokens).toBeVisible();
    await maxTokens.fill("2048");
    await maxTokens.blur();
    expect(
      await page.evaluate(() => (window as unknown as { app: { plugins: { plugins: Record<string, { settings: { maxTokens: number } }> } } }).app.plugins.plugins["claude-companion"].settings.maxTokens),
    ).toBe(2048);

    const fatal = consoleErrors.filter((e) => !e.includes("e2e-key") && !e.includes("127.0.0.1"));
    expect(fatal).toEqual([]);
  } finally {
    await harness.close();
  }
});

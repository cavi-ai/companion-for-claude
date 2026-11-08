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

for (const { width, zoom, theme } of [
  { width: 675, zoom: 1, theme: "dark" },
  { width: 350, zoom: 1, theme: "light" },
  { width: 350, zoom: 2, theme: "light" },
] as const) {
  test(`populated setting details fit ${width}px at ${zoom * 100}% zoom`, async ({ rig }) => {
    const harness = await rig.reset({ theme, settingsOverride: {
      setupWizardDone: true, mcpEnabled: true, mcpToken: "e2e-layout-token-for-local-test", mcpPort: 22360,
      systemPrompt: "Review each source in the current research project and cite the supporting note.\n\nKeep the original claim and supporting evidence together.\n\nExplain any disagreement before proposing a revision.\n\nPreserve the source title and URL.",
    } });
    const page = await harness.openSettings();
    try {
      await page.setViewportSize({ width: zoom === 2 ? 1800 : 1100, height: zoom === 2 ? 1570 : 785 });
      const actualZoom = await page.evaluate((factor) => {
        const frame = (window as unknown as { require(id: string): { webFrame: { setZoomFactor(value: number): void; getZoomFactor(): number } } }).require("electron").webFrame;
        frame.setZoomFactor(factor);
        return frame.getZoomFactor();
      }, zoom);
      expect(actualZoom).toBe(zoom);
      const tab = page.locator(".vertical-tab-content-container .vertical-tab-content").last();
      await expect(tab.getByRole("heading", { name: "Companion settings", exact: true })).toBeVisible();
      await tab.evaluate((element, paneWidth) => { element.style.width = `${paneWidth}px`; element.style.minWidth = "0"; element.style.maxWidth = `${paneWidth}px`; }, width);
      const search = tab.getByRole("searchbox", { name: "Search all settings" });

      await search.fill("Claude Code");
      const cli = tab.locator('.setting-item:has(.setting-item-name:text-is("Claude Code"))');
      await cli.getByRole("button", { name: "Check Claude Code", exact: true }).click();
      await expect(cli.locator(".cc-conn-status")).not.toHaveText("");
      await expect(cli).toHaveClass(/cc-setting-detail-row/);
      const cliBounds = await cli.evaluate((element) => {
        const action = element.querySelector(".setting-item-control")!.getBoundingClientRect();
        const status = element.querySelector(".cc-setting-detail")!.getBoundingClientRect();
        return { actionBottom: action.bottom, statusTop: status.top, overflow: element.scrollWidth - element.clientWidth };
      });
      expect(cliBounds.statusTop).toBeGreaterThanOrEqual(cliBounds.actionBottom);
      expect(cliBounds.overflow).toBeLessThanOrEqual(1);

      await tab.getByRole("button", { name: "Connections", exact: true }).click();
      const snippets = tab.locator('.setting-item:has(.setting-item-name:text-is("Connection snippets"))');
      await expect(snippets.locator(".cc-snippet")).toHaveCount(2);
      await snippets.scrollIntoViewIfNeeded();
      await expect(snippets.getByRole("button", { name: "Copy Claude Code", exact: true })).toBeVisible();
      const snippetBounds = await snippets.evaluate((element) => {
        const detail = element.querySelector<HTMLElement>(".cc-setting-detail")!;
        const boxes = [...element.querySelectorAll<HTMLElement>(".cc-snippet")].map((node) => node.getBoundingClientRect());
        return { overflow: element.scrollWidth - element.clientWidth, detailWidth: detail.clientWidth,
          blocks: [...element.querySelectorAll<HTMLElement>(".cc-snippet-pre")].map((node) => ({ width: node.clientWidth, scrollWidth: node.scrollWidth })),
          stacked: boxes[1]!.top >= boxes[0]!.bottom,
          copyInside: [...element.querySelectorAll<HTMLElement>(".cc-snippet-copy")].every((node) => node.getBoundingClientRect().right <= detail.getBoundingClientRect().right + 1),
        };
      });
      expect(snippetBounds.overflow).toBeLessThanOrEqual(1);
      expect(snippetBounds.stacked).toBe(true);
      expect(snippetBounds.copyInside).toBe(true);
      expect(snippetBounds.blocks.every((block) => block.width <= snippetBounds.detailWidth)).toBe(true);
      expect(snippetBounds.blocks[0]!.scrollWidth).toBeGreaterThan(snippetBounds.blocks[0]!.width);
      await snippets.screenshot({ path: test.info().outputPath(`connection-snippets-${width}-${zoom}.png`) });

      await search.fill("System prompt");
      const promptRow = tab.locator('.setting-item:has(.setting-item-name:text-is("System prompt"))');
      await expect(promptRow).toHaveClass(/cc-setting-editor-row/);
      const prompt = promptRow.getByRole("textbox", { name: "System prompt", exact: true });
      await prompt.fill("Keep the source and claim together.\n\nEdited at the current zoom.");
      await prompt.blur();
      const promptBounds = await promptRow.evaluate((element) => {
        const surface = element.closest<HTMLElement>(".cc-settings-surface")!;
        const surfaceStyle = getComputedStyle(surface);
        const info = element.querySelector(".setting-item-info")!.getBoundingClientRect();
        const editor = element.querySelector("textarea")!;
        const bounds = editor.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { surfaceWidth: surface.clientWidth, surfacePaddingLeft: parseFloat(surfaceStyle.paddingLeft), surfacePaddingRight: parseFloat(surfaceStyle.paddingRight),
          rowPaddingLeft: parseFloat(style.paddingLeft), rowPaddingRight: parseFloat(style.paddingRight),
          available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), width: bounds.width, height: bounds.height,
          editorTop: bounds.top, infoBottom: info.bottom, fontSize: parseFloat(getComputedStyle(editor).fontSize), resize: getComputedStyle(editor).resize,
          overflow: element.scrollWidth - element.clientWidth };
      });
      expect(promptBounds.editorTop).toBeGreaterThanOrEqual(promptBounds.infoBottom);
      expect(promptBounds.width).toBeGreaterThanOrEqual(promptBounds.available - 1);
      expect(promptBounds.surfacePaddingLeft).toBeLessThanOrEqual(16);
      expect(promptBounds.surfacePaddingRight).toBeLessThanOrEqual(16);
      expect(promptBounds.rowPaddingLeft).toBe(0);
      expect(promptBounds.rowPaddingRight).toBe(0);
      expect(promptBounds.width, "prompt must use the settings surface after one 16px edge allocation").toBeGreaterThanOrEqual(promptBounds.surfaceWidth - 33);
      expect(promptBounds.height).toBeGreaterThanOrEqual(8 * promptBounds.fontSize);
      expect(promptBounds.fontSize).toBeGreaterThanOrEqual(14);
      expect(promptBounds.resize).toBe("vertical");
      expect(promptBounds.overflow).toBeLessThanOrEqual(1);
      await promptRow.screenshot({ path: test.info().outputPath(`system-prompt-${width}-${zoom}.png`) });
      await expect(prompt).toHaveValue("Keep the source and claim together.\n\nEdited at the current zoom.");
      await test.info().attach("rich-settings-geometry", { body: JSON.stringify({ width, zoom, cliBounds, snippetBounds, promptBounds }, null, 2), contentType: "application/json" });

      await tab.getByRole("button", { name: "Files & privacy", exact: true }).click();
      expect(await tab.locator(".cc-settings-browser").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    } finally {
      if (!page.isClosed()) await page.evaluate(() => (window as unknown as { require(id: string): { webFrame: { setZoomFactor(value: number): void } } }).require("electron").webFrame.setZoomFactor(1));
      await harness.close();
    }
  });
}

import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

const OUTPUT = process.env.CC_E2E_OUTPUT_DIR ?? "/private/tmp/claude-companion-research-e2e-results";

async function openChat(page: Page): Promise<Locator> {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chrome = page.locator(".cc-companion-chrome").last();
  await expect(chrome).toBeVisible();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const deferSetup = page.getByRole("button", { name: "Not now" }).last();
    if (!await deferSetup.isVisible().catch(() => false)) break;
    await deferSetup.click();
  }
  return chrome;
}

test("completed activity clears and Quick Options stays inside compact viewports", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  try {
    let chrome = await openChat(page);
    await page.evaluate(() => {
      type ActivityPlugin = {
        activity: {
          start(input: { id: string; kind: "semantic-index"; title: string; total: number }): string;
          finish(id: string, update: { completed: number; succeeded: number }): void;
        };
      };
      const app = (window as unknown as {
        app: { plugins: { plugins: Record<string, ActivityPlugin> } };
      }).app;
      const activity = app.plugins.plugins["claude-companion"]!.activity;
      const id = activity.start({ id: "e2e-index", kind: "semantic-index", title: "Building semantic index", total: 1 });
      activity.finish(id, { completed: 1, succeeded: 1 });
    });

    const completedIndex = chrome.locator(".cc-activity-indicator.is-succeeded", { hasText: "Building semantic index" });
    await expect(completedIndex).toContainText("Complete");
    await expect(completedIndex).toBeHidden({ timeout: 5_000 });

    const promptCards = page.locator(".cc-empty-examples .cc-example");
    await expect(promptCards).toHaveCount(4);
    const promptGeometry = await promptCards.evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        clientHeight: card.clientHeight,
        scrollHeight: card.scrollHeight,
        clientWidth: card.clientWidth,
        scrollWidth: card.scrollWidth,
      };
    }));
    for (const card of promptGeometry) {
      expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1);
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    }
    for (let left = 0; left < promptGeometry.length; left += 1) {
      for (let right = left + 1; right < promptGeometry.length; right += 1) {
        const a = promptGeometry[left]!;
        const b = promptGeometry[right]!;
        const intersectionWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const intersectionHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        expect(intersectionWidth * intersectionHeight).toBe(0);
      }
    }
    await page.screenshot({ path: `${OUTPUT}/companion-activity-cleared.png` });

    await page.evaluate(() => {
      type ActivityPlugin = {
        activity: {
          start(input: { id: string; kind: "semantic-index"; title: string; total: number }): string;
          fail(id: string, update: { failed: number; recovery: Array<{ id: string; label: string; kind: "retry" }> }): void;
        };
      };
      const app = (window as unknown as {
        app: { plugins: { plugins: Record<string, ActivityPlugin> } };
      }).app;
      const activity = app.plugins.plugins["claude-companion"]!.activity;
      const id = activity.start({ id: "e2e-failure", kind: "semantic-index", title: "Index needs attention", total: 1 });
      activity.fail(id, { failed: 1, recovery: [{ id: "retry", label: "Retry indexing", kind: "retry" }] });
    });

    await page.setViewportSize({ width: 960, height: 700 });
    for (const width of [280, 320, 360, 480, 768]) {
      chrome = page.locator(".cc-companion-chrome").last();
      await chrome.evaluate((element, paneWidth) => {
        const pane = element.closest(".workspace-split.mod-right-split")
          ?? element.closest(".workspace-leaf")?.parentElement;
        if (!(pane instanceof HTMLElement)) throw new Error("Companion pane container not found");
        pane.style.width = `${paneWidth}px`;
        pane.style.minWidth = `${paneWidth}px`;
        pane.style.maxWidth = `${paneWidth}px`;
        pane.style.flex = `0 0 ${paneWidth}px`;
        pane.style.position = "fixed";
        pane.style.inset = "0 0 0 auto";
        pane.style.zIndex = "20";
      }, width);
      const activityTrigger = chrome.locator(".cc-activity-indicator", { hasText: "Index needs attention" });
      await activityTrigger.click();
      const drawer = chrome.locator(".cc-activity-drawer");
      await expect(drawer).toBeVisible();
      const drawerBounds = await drawer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const pane = element.closest(".workspace-leaf")?.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: innerWidth,
          paneLeft: pane?.left,
          paneRight: pane?.right,
        };
      });
      expect(drawerBounds.left).toBeGreaterThanOrEqual(7);
      expect(drawerBounds.right).toBeLessThanOrEqual(drawerBounds.viewportWidth - 7);
      if (drawerBounds.paneLeft !== undefined && drawerBounds.paneRight !== undefined) {
        expect(drawerBounds.left).toBeGreaterThanOrEqual(drawerBounds.paneLeft - 1);
        expect(drawerBounds.right).toBeLessThanOrEqual(drawerBounds.paneRight + 1);
      }
      await activityTrigger.click();
      await expect(drawer).toBeHidden();
    }

    await chrome.evaluate((element) => {
      const pane = element.closest(".workspace-split.mod-right-split")
        ?? element.closest(".workspace-leaf")?.parentElement;
      if (!(pane instanceof HTMLElement)) return;
      pane.style.removeProperty("width");
      pane.style.removeProperty("min-width");
      pane.style.removeProperty("max-width");
      pane.style.removeProperty("flex");
      pane.style.removeProperty("position");
      pane.style.removeProperty("inset");
      pane.style.removeProperty("z-index");
    });

    for (const width of [280, 320, 360, 480, 768]) {
      await page.setViewportSize({ width, height: 560 });
      chrome = page.locator(".cc-companion-chrome").last();
      const trigger = chrome.getByRole("button", { name: /Quick options for/i });
      await trigger.click();
      const modal = page.locator(".modal.cc-quick-options-shell");
      await expect(modal).toBeVisible();

      const bounds = await modal.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(7);
      expect(bounds.top).toBeGreaterThanOrEqual(7);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 7);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 7);
      await expect(modal.getByRole("button", { name: "Open all settings" })).toBeAttached();

      if (width === 320 || width === 768) {
        await page.screenshot({ path: `${OUTPUT}/companion-quick-options-${width}.png` });
      }
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
      await expect(trigger).toBeFocused();
    }
  } finally {
    await harness.close();
  }
});

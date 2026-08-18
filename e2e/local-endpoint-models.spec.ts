import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

const MODELS = ["mlx-community/Qwen3-8B-4bit", "lmstudio/gemma-3-12b"];

const openChat = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
};

// The reported bug: an OpenAI-compatible endpoint (LM Studio et al.) is configured
// with a host but no model id, so nothing appeared in the chat model picker.
test("the chat picker lists every model the local endpoint serves", async () => {
  const harness = await launchObsidianHarness({ endpointModels: MODELS });
  const { page } = harness;
  try {
    await openChat(page);
    const select = page.locator(".cc-ctl-model .cc-ctl-select");
    await expect(select).toBeVisible();

    const group = select.locator('optgroup[label="Local (endpoint)"]');
    await expect(group).toHaveCount(1, { timeout: 10_000 });
    await expect(group.locator("option")).toHaveCount(MODELS.length);
    for (const model of MODELS) {
      await expect(group.locator("option", { hasText: model })).toHaveCount(1);
    }

    // Picking one routes chat at the endpoint and records the id, so the header
    // label and the picker agree instead of only the header updating.
    await select.selectOption(`custom:${MODELS[1]}`);
    await expect.poll(async () => await page.evaluate(() => {
      const app = (window as unknown as {
        app: { plugins: { plugins: Record<string, { settings: { openaiCompatModel: string; chatBackend: string } }> } };
      }).app;
      const settings = app.plugins.plugins["claude-companion"]!.settings;
      return `${settings.chatBackend}|${settings.openaiCompatModel}`;
    })).toBe(`custom|${MODELS[1]}`);
    await expect(page.locator(".cc-model").first()).toContainText(MODELS[1]!);
  } finally {
    await harness.close();
  }
});

test("Detect fills the endpoint model dropdown in settings", async () => {
  const harness = await launchObsidianHarness({ endpointModels: MODELS });
  const { page } = harness;
  try {
    await page.evaluate(() => {
      const app = (window as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
      app.setting.open();
      app.setting.openTabById("claude-companion");
    });
    const tab = page.locator(".vertical-tab-content-container .vertical-tab-content").last();
    await expect(tab).toBeVisible();
    await expect(tab.locator(".setting-item").first()).toBeVisible({ timeout: 10_000 });
    // The tab is declarative since 0.27.1: sections are host-rendered pages, so
    // open the page by its name before reaching for a row inside it.
    await tab.locator(".setting-item", { hasText: "Local models (Ollama & endpoints)" }).first().click();

    const local = tab.locator(".setting-item", { hasText: "Endpoint model" }).first();
    await expect(local).toBeVisible({ timeout: 10_000 });

    // Before Detect the field is free text — the endpoint's ids are unknown.
    await expect(local.locator("select")).toHaveCount(0);
    // setTooltip puts the tooltip on aria-label, so the button's accessible name
    // is not "Detect" — match its text.
    await local.locator("button").filter({ hasText: "Detect" }).click();

    const dropdown = local.locator("select");
    await expect(dropdown).toHaveCount(1, { timeout: 10_000 });
    for (const model of MODELS) {
      await expect(dropdown.locator("option", { hasText: model })).toHaveCount(1);
    }
    // Detect adopts the first served model rather than leaving the id blank.
    await expect(dropdown).toHaveValue(MODELS[0]!);
  } finally {
    await harness.close();
  }
});

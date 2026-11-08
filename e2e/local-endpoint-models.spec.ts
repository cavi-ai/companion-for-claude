import { expect, openSettingsSection, test } from "./fixtures";
import { setRightSidebarWidth } from "./rig/pageOps";
import { modelLabel } from "../src/claude/models";

const MODELS = ["mlx-community/Qwen3-8B-4bit", "lmstudio/gemma-3-12b"];

const openChat = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
};

// The reported bug: an OpenAI-compatible endpoint (LM Studio et al.) is configured
// with a host but no model id, so nothing appeared in the chat model picker.
test("the chat picker lists every model the local endpoint serves", async ({ rig }) => {
  const harness = await rig.reset({ endpointModels: MODELS });
  const { page } = harness;
  try {
    await openChat(page);
    const chat = page.locator(".cc-chat-root");
    const select = chat.locator(".cc-ctl-model .cc-ctl-select");
    await expect(select).toBeHidden();
    await chat.locator(".cc-model").click();
    const chooser = page.locator(".cc-model-picker");
    const endpoints = chooser.locator('[data-backend="custom"] .cc-model-option');
    await expect(endpoints).toHaveCount(MODELS.length);
    for (const model of MODELS) {
      await expect(chooser.locator(`[data-model-value="custom:${model}"]`)).toBeVisible();
    }
    await chooser.locator(`[data-model-value="custom:${MODELS[0]}"]`).click();
    await expect(chat.locator(".cc-model-backend")).toHaveText("Endpoint");
    await expect(chat.getByRole("button", { name: `Choose model and backend: Endpoint · ${modelLabel(MODELS[0]!)}`, exact: true })).toBeVisible();

    // The duplicate picker is available when the pane has room for the full rail.
    await setRightSidebarWidth(page, 768);
    await expect(select).toBeVisible();

    const group = select.locator('optgroup[label="Endpoint"]');
    await expect(group).toHaveCount(1, { timeout: 10_000 });
    await expect(group.locator("option")).toHaveCount(MODELS.length);
    for (const model of MODELS) {
      await expect(group.locator("option", { hasText: model })).toHaveCount(1);
    }

    // Picking one routes chat at the endpoint and records the id, so the header
    // label and the picker agree instead of only the header updating.
    await select.selectOption(`custom:${MODELS[1]}`);
    // The header shows the formatted label; the picker keeps the raw id.
    await expect(chat.locator(".cc-model-text")).toHaveText(modelLabel(MODELS[1]!));
    await expect(chat.getByRole("button", { name: `Choose model and backend: Endpoint · ${modelLabel(MODELS[1]!)}`, exact: true })).toBeVisible();
    // It records the choice, not just the live DOM: survives a plugin restart.
    await harness.reloadPlugin();
    await openChat(page);
    await expect(chat.locator(".cc-model-backend")).toHaveText("Endpoint");
    await expect(chat.locator(".cc-model-text")).toHaveText(modelLabel(MODELS[1]!));
    await expect(chat.getByRole("button", { name: `Choose model and backend: Endpoint · ${modelLabel(MODELS[1]!)}`, exact: true })).toBeVisible();
    await setRightSidebarWidth(page, 768);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(`custom:${MODELS[1]}`);
  } finally {
    await harness.close();
  }
});

test("Detect fills the endpoint model dropdown in settings", async ({ rig }) => {
  const harness = await rig.reset({ endpointModels: MODELS });
  const { page } = harness;
  try {
    const settingsPage = await openSettingsSection(harness, "Local models");
    const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
    await expect(tab).toBeVisible();
    await expect(tab.locator(".setting-item:visible").first()).toBeVisible({ timeout: 10_000 });
    const local = tab.locator(".setting-item", { hasText: "Endpoint model" }).first();
    await expect(local).toBeVisible({ timeout: 10_000 });

    // Before Detect the field is free text — the endpoint's ids are unknown.
    await expect(local.locator("select:not(.is-measuring)")).toHaveCount(0);
    // setTooltip puts the tooltip on aria-label, so the button's accessible name
    // is not "Detect" — match its text.
    await local.locator("button").filter({ hasText: "Detect" }).click();

    // Skip Obsidian 1.13's hidden measuring twin; it is not the control.
    const dropdown = local.locator("select:not(.is-measuring)");
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

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("a reset starts a clean vault and stock settings, not the previous scenario's", async ({ rig }) => {
  const first = await rig.reset({
    extraFiles: { "Transient.md": "# Must not leak\n" },
    settingsOverride: { customModel: "temporary-e2e-model" },
  });
  const processId = first.processId;
  await expect.poll(() => stat(join(first.paths.vault, "Transient.md")).then(() => true, () => false)).toBe(true);
  const firstSettings = await first.openSettings();
  const firstTab = firstSettings.locator(".vertical-tab-content-container .vertical-tab-content").last();
  const firstCustomModel = firstTab.locator(".setting-item", { hasText: "Custom model id" }).locator("input");
  await expect(firstCustomModel).toHaveValue("temporary-e2e-model");

  const second = await rig.reset();
  expect(second.processId).toBe(processId);
  await expect.poll(() => stat(join(second.paths.vault, "Transient.md")).then(() => true, () => false)).toBe(false);
  const settingsPage = await second.openSettings();
  const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
  const customModel = tab.locator(".setting-item", { hasText: "Custom model id" }).locator("input");
  await expect(customModel).toHaveValue("");
});

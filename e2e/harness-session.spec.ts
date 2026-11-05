import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, openSettingsSection, test } from "./fixtures";

test("a reset starts a clean vault and stock settings, not the previous scenario's", async ({ rig }) => {
  const first = await rig.reset({
    extraFiles: { "Transient.md": "# Must not leak\n" },
    settingsOverride: { customModel: "temporary-e2e-model" },
  });
  const processId = first.processId;
  await expect.poll(() => stat(join(first.paths.vault, "Transient.md")).then(() => true, () => false)).toBe(true);
  const firstSettings = await openSettingsSection(first, "Provider & model");
  const firstTab = firstSettings.locator(".vertical-tab-content-container .vertical-tab-content").last();
  const firstCustomModel = firstTab.locator(".setting-item", { has: firstSettings.getByText("Custom model id", { exact: true }) }).locator("input");
  await expect(firstCustomModel).toHaveValue("temporary-e2e-model");

  const second = await rig.reset();
  expect(second.processId).toBe(processId);
  await expect.poll(() => stat(join(second.paths.vault, "Transient.md")).then(() => true, () => false)).toBe(false);
  const settingsPage = await openSettingsSection(second, "Provider & model");
  const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
  const customModel = tab.locator(".setting-item", { has: settingsPage.getByText("Custom model id", { exact: true }) }).locator("input");
  await expect(customModel).toHaveValue("");
});


test("closing a scenario saves pending editor text before ownership is sealed", async ({ rig }) => {
  const first = await rig.reset({ extraFiles: { "Pending.md": "Before." } });
  await first.page.evaluate(async () => {
    const app = (window as unknown as { app: {
      vault: { getFileByPath(path: string): unknown };
      workspace: { getLeaf(create: boolean): { openFile(file: unknown): Promise<void>; view: { editor: { setValue(value: string): void } } } };
    } }).app;
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getFileByPath("Pending.md"));
    leaf.view.editor.setValue("An edit still waiting for Obsidian's debounced save.");
  });
  await first.close();
  expect(await readFile(join(first.paths.vault, "Pending.md"), "utf8")).toBe("An edit still waiting for Obsidian's debounced save.");
  expect(await first.page.evaluate(() => Boolean((window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins["claude-companion"]))).toBe(true);
  await first.page.evaluate(() => {
    const app = (window as unknown as { app: import("obsidian").App }).app;
    (app.workspace.getLeavesOfType("markdown")[0]!.view as import("obsidian").MarkdownView).editor.setValue("A later test in the same shared scenario.");
  });
  await first.close();
  expect(await readFile(join(first.paths.vault, "Pending.md"), "utf8")).toBe("A later test in the same shared scenario.");
  await rig.reset();
  await expect.poll(() => stat(join(rig.paths.vault, "Pending.md")).then(() => true, () => false)).toBe(false);
});

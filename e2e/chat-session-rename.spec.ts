import { expect, test } from "./fixtures";

test("session titles can be saved with the mouse and cancelled without changes", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false },
    providerReply: [{ match: ".", replies: ["The pilot findings remain preliminary."] }],
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { setConfig(key: string, value: boolean): void }; commands: { executeCommandById(id: string): Promise<void> } } }).app;
    app.vault.setConfig("nativeMenus", false);
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("Summarize the pilot");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  const history = page.locator(".cc-session-dropdown");
  const modal = page.locator(".modal").filter({ hasText: "Rename session" });
  const title = modal.getByRole("textbox", { name: "Session title", exact: true });
  const save = modal.getByRole("button", { name: "Save", exact: true });
  const openRename = async () => {
    if (!await history.isVisible()) await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await history.locator(".cc-session-more").click();
    await page.locator(".menu").getByText("Rename", { exact: true }).click();
    await expect(title).toBeFocused();
  };

  await openRename();
  await title.fill("   ");
  await expect(save).toBeDisabled();
  await title.press("Enter");
  await expect(modal).toBeVisible();
  await title.fill("  Pilot decisions  ");
  await expect(save).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("rename-with-save-and-cancel.png") });
  await save.click();
  await expect(history.locator(".cc-session-title")).toHaveText("Pilot decisions");

  for (const cancel of ["button", "escape", "close"]) {
    await openRename();
    await title.fill("Discard this title");
    if (cancel === "button") await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    else if (cancel === "escape") await title.press("Escape");
    else await modal.locator(".modal-header-button").click();
    await expect(modal).toHaveCount(0);
    await expect(history.locator(".cc-session-title")).toHaveText("Pilot decisions");
  }
  await openRename();
  await title.fill("Pilot next steps");
  await title.press("Enter");
  await expect(history.locator(".cc-session-title")).toHaveText("Pilot next steps");
  await rig.reloadPlugin();
  await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
  await expect(history.locator(".cc-session-title")).toHaveText("Pilot next steps");
  expect(await rig.providerRequests()).toBe(1);
});

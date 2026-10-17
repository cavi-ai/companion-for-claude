import { expect, test } from "./fixtures";

test("reusing a question protects existing drafts and keeps empty reuse immediate", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    providerReply: [{ match: ".", replies: ["The pilot findings remain preliminary."] }],
  });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  const prompt = "Summarize the pilot findings.";
  const draft = "  Compare the pilot.\nKeep the limitations clear.  ";
  await input.fill(prompt);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  const reuse = chat.locator(".cc-user").getByRole("button", { name: "Use again", exact: true });
  const modal = page.locator(".modal").filter({ hasText: "Replace current draft?" });
  await input.fill(draft);
  await reuse.click();
  await expect(modal).toBeVisible();
  await expect(input).toHaveValue(draft);
  await expect(modal.getByRole("button", { name: "Keep draft", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("replace-draft-confirmation.png") });
  await page.keyboard.press("Enter");
  await expect(modal).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();

  await reuse.click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("draft-preserved-after-cancel.png") });

  await reuse.click();
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(input).toHaveValue(prompt);
  await expect(input).toBeFocused();
  await reuse.click();
  await expect(modal).toHaveCount(0);
  await expect(input).toHaveValue(prompt);
  await input.fill("");
  await reuse.click();
  await expect(modal).toHaveCount(0);
  await expect(input).toHaveValue(prompt);
  expect(await rig.providerRequests()).toBe(1);
});

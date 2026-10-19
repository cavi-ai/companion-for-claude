import { expect, test } from "./fixtures";

test("starter and workspace actions ask before replacing or sending an unfinished draft", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    extraFiles: { "Pilot.md": "# Pilot\n\nFour participants." },
    providerReply: [{ match: ".", replies: ["The findings remain preliminary."] }],
  });
  await page.locator('.nav-file-title[data-path="Pilot.md"]').dblclick();
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  const modal = page.locator(".modal").filter({ hasText: "Replace current draft?" });
  const draft = "Compare the pilot limitations with my follow-up plan.";
  const starter = chat.getByRole("button", { name: /Summarize my active note/ });
  await input.pressSequentially(draft);
  await starter.click();
  await expect(modal).toBeVisible();
  await expect(input).toHaveValue(draft);
  expect(await rig.providerRequests()).toBe(0);
  await modal.getByRole("button", { name: "Keep draft", exact: true }).click();
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();
  await expect(chat.locator(".cc-user")).toHaveCount(0);

  const workspace = chat.getByRole("button", { name: "Ask about this note", exact: true });
  await workspace.click();
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Keep draft", exact: true }).click();
  await expect(input).toHaveValue(draft);
  await workspace.click();
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(input).toHaveValue("Help me continue working with Pilot. ");
  expect(await rig.providerRequests()).toBe(0);

  await input.fill(draft);
  await starter.click();
  await page.screenshot({ path: testInfo.outputPath("starter-draft-confirmation.png") });
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(chat.locator(".cc-user")).toContainText("Summarize my active note as concise bullet points");
  await expect(chat.locator(".cc-context-note")).toContainText("1 attached");
  expect(await rig.providerRequests()).toBe(1);
});

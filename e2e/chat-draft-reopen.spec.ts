import { expect, test } from "./fixtures";

type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void } } };

test("Undo close tab restores its unsent chat draft", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const command = (id: string) => page.evaluate((value) => (window as unknown as TestWindow).app.commands.executeCommandById(value), id);
  await command("claude-companion:new-chat-tab");
  const chat = page.locator(".cc-chat-root");
  const draft = "Compare the pilot with the follow-up.\nKeep the original limitations explicit.  ";
  await chat.locator(".cc-input").fill(draft);
  await command("workspace:close");
  await expect(chat).toHaveCount(0);
  await command("workspace:undo-close-pane");
  await expect(chat).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("reopened-draft.png") });
  await expect(chat.locator(".cc-input")).toHaveValue(draft);
  expect(await rig.providerRequests()).toBe(0);
  expect(errors).toEqual([]);
});

test("reopened chat keeps separate conversation drafts through plugin reload", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [{ match: ".", replies: ["Saved answer."] }],
  });
  const command = (id: string) => page.evaluate((value) => (window as unknown as TestWindow).app.commands.executeCommandById(value), id);
  await command("claude-companion:new-chat-tab");
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  await input.fill("Original question");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  const followup = "A separate follow-up.  ";
  await input.fill(followup);
  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  const next = "New chat's unfinished question";
  await input.fill(next);
  await command("workspace:close");
  await expect(chat).toHaveCount(0);
  await command("workspace:undo-close-pane");
  await expect(input).toHaveValue(next);
  await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
  await page.locator(".cc-session-row").filter({ hasText: "Original question" }).click();
  await expect(input).toHaveValue(followup);
  await rig.reloadPlugin();
  await expect(input).toHaveValue(followup);
  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(input).toHaveValue(next);
  expect(await rig.providerRequests()).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("separate-drafts-after-reload.png") });
});

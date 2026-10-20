import { expect, test } from "./fixtures";

test("only the latest answer offers regeneration before and after reopening", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [{ match: ".", replies: ["The pilot started in March."] }],
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const answers = chat.locator(".cc-assistant");
  const regenerate = chat.getByRole("button", { name: "Regenerate", exact: true });
  const send = async (prompt: string) => {
    await chat.locator(".cc-input").fill(prompt);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(answers.last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  };
  await send("When did the pilot start?");
  await expect(regenerate).toHaveCount(1);
  await rig.control.setStubs({ providerReply: [{ match: ".", replies: ["Four people participated.", "Four people joined the pilot."] }] });
  await send("How many people participated?");
  await expect(answers).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("two-answer-actions.png") });
  await expect(answers.first().getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  await expect(regenerate).toHaveCount(1);

  await rig.reloadPlugin();
  await expect(answers).toHaveCount(2);
  await expect(answers.first().getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  await expect(regenerate).toHaveCount(1);
  await regenerate.click();
  await expect(answers.last().locator(".cc-body")).toContainText("Four people joined the pilot.");
  await expect(answers).toHaveCount(2);
  await expect(answers.first().locator(".cc-body")).toContainText("The pilot started in March.");
  await expect(regenerate).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("regenerated-latest-answer.png") });
  expect(errors).toEqual([]);
});

test("an earlier failed request no longer offers Retry after the next question", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false },
    providerFail: [{ match: ".", status: 503 }],
  });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("When did the pilot start?");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-error").getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await rig.control.setStubs({ providerReply: [{ match: ".", replies: ["Four people participated."] }] });
  await chat.locator(".cc-input").fill("How many people participated?");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(chat.locator(".cc-error-retry")).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(1);
});

import { expect, test } from "./fixtures";

test("Research Desk sends preserve an unrelated chat draft until it is explicitly sent", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    providerReply: [{ match: ".", replies: ["The evidence remains preliminary. Review its supporting passages."] }],
  });
  const run = (id: string) => page.evaluate(async (id) => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById(id);
  }, id);
  await run("claude-companion:open-chat");
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  const draft = "  Compare the pilot and follow-up.\nKeep the assumptions explicit.  ";
  await input.fill(draft);
  await run("claude-companion:open-research-desk");
  const desk = page.locator(".cc-research-desk");
  const instruction = "Summarize the claim and its strongest conflicting passage.";
  await desk.getByLabel("Instruction for Claude").fill(instruction);
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(chat.locator(".cc-user")).toContainText(instruction);
  await expect(input).toHaveValue(draft);
  expect(await rig.providerRequests()).toBe(1);
  await chat.locator(".cc-context-trigger").click();
  await expect(chat.getByRole("dialog", { name: "Message context" }).getByText("Research/Alpha/Project.md", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Close message context" }).click();
  await page.screenshot({ path: testInfo.outputPath("research-reply-with-chat-draft-preserved.png") });
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(chat.locator(".cc-user").last()).toContainText("Compare the pilot and follow-up.");
  await expect(chat.locator(".cc-user")).toHaveCount(2);
  await expect(input).toHaveValue("");
  expect(await rig.providerRequests()).toBe(2);
});

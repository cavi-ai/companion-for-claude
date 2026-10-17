import { expect, test } from "./fixtures";

test("refused sends retain exact drafts and can be sent after correcting credentials", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      chatBackend: "custom", openaiCompatHost: "", openaiCompatModel: "", apiKey: "",
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    providerReply: [{ match: ".", replies: ["The pilot findings remain preliminary."] }],
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  const question = "  Compare the pilot.\nKeep the assumptions separate.  ";
  for (const draft of [question, "  /wikilink-weaver Notes/Alpha.md  "]) {
    await input.fill(draft);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").last()).toContainText("Add your Anthropic credential");
    await expect(input).toHaveValue(draft);
    await expect(chat.locator(".cc-user")).toHaveCount(0);
  }
  expect(await rig.providerRequests()).toBe(0);
  await input.fill(question);
  await page.screenshot({ path: testInfo.outputPath("refused-draft-retained.png") });

  const settings = await rig.openSettings();
  const key = settings.locator("input[type='password'][placeholder*='sk-ant-api']");
  await key.fill("e2e-key");
  await key.blur();
  await settings.keyboard.press("Escape").catch((error: unknown) => {
    if (!settings.isClosed()) throw error;
  });
  await expect(input).toHaveValue(question);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body")).toContainText("The pilot findings remain preliminary.");
  await expect(input).toHaveValue("");
  await expect(chat.locator(".cc-user")).toHaveCount(1);
  await expect(chat.locator(".cc-user .cc-body")).toContainText("Compare the pilot.");
  expect(await rig.providerRequests()).toBe(1);
});

import { expect, test } from "./fixtures";

type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void } } };

test("Undo close tab restores the explicit note attached to its draft", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Notes/DraftContext.md": "# Draft context\n\nsource-sentinel-991" },
    providerReply: [{ match: "/(?=[\\s\\S]*Attached: Notes/DraftContext[.]md)(?=[\\s\\S]*source-sentinel-991)/", replies: ["The attached source is restored."] }],
  });
  const command = (id: string) => page.evaluate((value) => (window as unknown as TestWindow).app.commands.executeCommandById(value), id);
  await command("claude-companion:new-chat-tab");
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  await input.fill("@DraftContext");
  await expect(chat.locator(".cc-at-item.is-selected")).toContainText("DraftContext");
  await input.press("Enter");
  await chat.locator(".cc-context-trigger").click();
  const context = chat.getByRole("dialog", { name: "Message context" });
  await expect(context).toContainText("Notes/DraftContext.md");
  await context.getByRole("checkbox", { name: "Entire vault", exact: true }).check();
  await context.getByRole("button", { name: "Close message context" }).click();
  await input.fill("Summarize this source.");
  await command("workspace:close");
  await expect(chat).toHaveCount(0);
  await command("workspace:undo-close-pane");
  await expect(input).toHaveValue("Summarize this source.");
  await chat.locator(".cc-context-trigger").click();
  await page.screenshot({ path: testInfo.outputPath("draft-context-after-reopen.png") });
  await expect(context).toContainText("Notes/DraftContext.md");
  await expect(context.getByRole("checkbox", { name: "Entire vault", exact: true })).toBeChecked();
  await context.getByRole("button", { name: "Close message context" }).click();
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The attached source is restored.");
  expect(await rig.providerRequests()).toBe(1);
  await rig.reloadPlugin();
  await chat.locator(".cc-context-trigger").click();
  await expect(context).toContainText("Notes/DraftContext.md");
  await expect(context.getByRole("checkbox", { name: "Entire vault", exact: true })).toBeChecked();
});

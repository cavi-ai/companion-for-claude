import { expect, test } from "./fixtures";

test("empty chat follows note navigation without replacing an unfinished draft", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    extraFiles: { "Pilot.md": "# Pilot\n\nFour participants.", "Follow-up.md": "# Follow-up\n\nRecruit more participants." },
    providerReply: [{ match: ".", replies: ["The findings remain preliminary."] }],
  });
  const openNote = (path: string) => page.locator(`.nav-file-title[data-path="${path}"]`).dblclick();
  await openNote("Pilot.md");
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const card = chat.getByRole("region", { name: "Current Companion workspace" });
  const input = chat.locator(".cc-input");
  await expect(card.getByRole("heading")).toHaveText("Continue with Pilot");
  await card.getByRole("button", { name: "Ask about this note", exact: true }).click();
  const draft = "Keep my unfinished comparison.\nCheck the limitations.";
  await input.fill(draft);
  await openNote("Follow-up.md");
  await expect(card.getByRole("heading")).toHaveText("Continue with Follow-up");
  await expect(card).toContainText("Follow-up.md");
  await expect(input).toHaveValue(draft);
  await page.screenshot({ path: testInfo.outputPath("current-workspace-after-navigation.png") });
  await card.getByRole("button", { name: "Ask about this note", exact: true }).click();
  await page.locator(".modal").filter({ hasText: "Replace current draft?" }).getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(input).toHaveValue("Help me continue working with Follow-up. ");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(chat.locator(".cc-context-note")).toContainText("2 attached");
  const user = await chat.locator(".cc-user").innerText();
  await openNote("Pilot.md");
  await expect(card).toHaveCount(0);
  await expect.poll(() => chat.locator(".cc-user").innerText()).toBe(user);
  expect(await rig.providerRequests()).toBe(1);
});

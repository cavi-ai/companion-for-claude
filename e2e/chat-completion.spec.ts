import { expect, test } from "./fixtures";

test("background completion leaves history reachable and opens the reply by keyboard", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    providerDelayMs: 1000,
    providerReply: [{ match: ".", replies: ["The pilot findings remain preliminary."] }],
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
  });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const question = "Summarize the pilot findings and keep the limitations clear.";
  await chat.locator(".cc-input").fill(question);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  const ready = page.getByRole("button", { name: `Reply ready: ${question}`, exact: true });
  await expect(ready).toBeVisible();
  await expect(page.locator(".notice").filter({ hasText: "Claude finished:" })).toHaveCount(0);
  await expect(page.locator(".cc-turn-complete-status")).toHaveAttribute("role", "status");
  await expect(ready).toHaveJSProperty("tabIndex", 0);

  const history = chat.getByRole("button", { name: "Resume a past conversation", exact: true });
  // A physical click must reach history on its first attempt, without clearing feedback.
  const box = (await history.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".cc-session-dropdown")).toBeVisible();
  await expect(page.locator(".cc-session-dropdown")).toContainText(question);
  await expect(ready).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("history-with-reply-ready.png") });
  await history.click();

  await ready.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(ready).toBeFocused();
  await expect(ready).toHaveCSS("outline-style", "solid");
  await expect(ready).toHaveCSS("outline-width", "2px");
  await page.screenshot({ path: testInfo.outputPath("reply-ready-keyboard-focus.png") });
  await page.keyboard.press("Enter");
  await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The pilot findings remain preliminary.");
  await expect(ready).toHaveCount(0);
  expect(await rig.providerRequests()).toBe(1);
});

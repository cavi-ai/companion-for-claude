import { expect, test } from "./fixtures";

type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void } } };
test("a URL typed during a reply offers page capture when it finishes", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerDelayMs: 3000,
    providerReply: [{ match: "First question", replies: ["First answer."] }],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("First question");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
    const question = "Next, summarize https://example.test/article";
    await input.fill(question);
    await expect(chat.locator(".cc-page-offer")).toBeHidden();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("First answer.");
    await expect(chat.getByRole("button", { name: /^Send(?: message)?$/ })).toBeVisible();
    await expect(input).toHaveValue(question);
    await expect(chat.locator(".cc-page-offer-btn")).toBeVisible();
    expect(await rig.providerRequests()).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("url-offer-restored-after-reply.png") });
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); }
});

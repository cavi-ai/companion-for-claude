import { expect, test } from "./fixtures";

type TestWindow = Window & {
  app: {
    commands: { executeCommandById(id: string): void };
    plugins: { plugins: Record<string, { settings: { apiKey: string }; saveSettings(): Promise<void> }> };
  };
};

test("Research Desk keeps the credential failure reason and retains the instruction for retry", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { apiKey: "", oauthToken: "" }, providerReply: [{ match: "/./", replies: ["Research instruction accepted."] }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const desk = page.locator(".cc-research-desk");
  const openDesk = () => page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-research-desk"));
  await openDesk();
  const instruction = "Summarize why the source matters.";
  await desk.getByLabel("Instruction for Claude").fill(instruction);
  await page.evaluate(() => document.querySelectorAll(".notice").forEach((notice) => notice.remove()));
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  const notices = page.locator(".notice");
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText("Add your Anthropic credential");
  await expect(page.locator(".cc-chat-root .cc-msg.cc-user")).toHaveCount(0);
  expect(await rig.providerRequests()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("credential-guidance-only.png") });
  await openDesk();
  await expect(desk.getByLabel("Instruction for Claude")).toHaveValue(instruction);
  await page.evaluate(async () => { const plugin = (window as unknown as TestWindow).app.plugins.plugins["claude-companion"]!; plugin.settings.apiKey = "e2e-key"; await plugin.saveSettings(); });
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  const chat = page.locator(".cc-chat-root");
  await expect(chat.locator(".cc-msg.cc-user").last()).toContainText(instruction);
  await expect(chat.locator(".cc-assistant .cc-body")).toContainText("Research instruction accepted.");
  await chat.locator(".cc-context-trigger").click();
  await expect(chat.getByRole("dialog", { name: "Message context" }).getByText("Research/Alpha/Project.md", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Close message context" }).click();
  expect(await rig.providerRequests()).toBe(1);
  expect(errors).toEqual([]);
});

test("Research Desk reports an actual running request and keeps the unsent instruction", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ providerDelayMs: 5000 });
  const run = (id: string) => page.evaluate((command) => (window as unknown as TestWindow).app.commands.executeCommandById(command), id);
  await run("claude-companion:open-chat");
  const chat = page.locator(".cc-chat-root");
  await chat.locator("textarea").fill("First question");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await expect.poll(() => rig.providerRequests()).toBe(1);
  await run("claude-companion:open-research-desk");
  const desk = page.locator(".cc-research-desk");
  const instruction = "Compare the project evidence.";
  await desk.getByLabel("Instruction for Claude").fill(instruction);
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Another request is in progress" })).toBeVisible();
  await expect(chat.locator(".cc-msg.cc-user")).toHaveCount(1);
  expect(await rig.providerRequests()).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("running-request-guidance.png") });
  await chat.getByRole("button", { name: "Stop generating", exact: true }).click();
  await rig.control.setStubs({ providerReply: [{ match: "/./", replies: ["Research retry accepted."] }] });
  await run("claude-companion:open-research-desk");
  await expect(desk.getByLabel("Instruction for Claude")).toHaveValue(instruction);
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.locator(".cc-msg.cc-user").last()).toContainText(instruction);
  await expect(chat.locator(".cc-assistant .cc-body").last()).toContainText("Research retry accepted.");
});

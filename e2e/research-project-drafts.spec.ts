import { expect, test } from "./fixtures";

test("Research Desk keeps project drafts separate during navigation and sends", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    providerDelayMs: 3000,
    providerReply: [{ match: ".", replies: ["Review the supporting and challenging evidence."] }],
  });
  const run = (id: string) => page.evaluate(async (id) => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById(id);
  }, id);
  await run("claude-companion:open-research-desk");
  const desk = page.locator(".cc-research-desk");
  const project = desk.getByLabel("Active research project");
  const input = desk.getByLabel("Instruction for Claude");
  const alpha = "  Compare the continuity claim.\nKeep the limitations explicit.  ";
  const beta = "Define the separate project population.\nThen define its outcome.";
  await input.fill(alpha);
  await project.selectOption("Research/Beta/Project.md");
  await expect(input).toHaveValue("");
  await input.fill(beta);
  await project.selectOption("Research/Alpha/Project.md");
  await expect(input).toHaveValue(alpha);
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  const chat = page.locator(".cc-chat-root");
  await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await run("claude-companion:open-research-desk");
  await project.selectOption("Research/Beta/Project.md");
  await expect(input).toHaveValue(beta);
  await run("claude-companion:open-chat");
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await run("claude-companion:open-research-desk");
  await expect(input).toHaveValue(beta);
  await project.selectOption("Research/Alpha/Project.md");
  await expect(input).toHaveValue("");
  await input.fill("Summarize the strongest challenge.");
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await run("claude-companion:open-research-desk");
  const followup = "Next: compare this with the larger follow-up study.";
  await input.fill(followup);
  await run("claude-companion:open-chat");
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toHaveCount(2);
  await run("claude-companion:open-research-desk");
  await expect(input).toHaveValue(followup);
  await project.selectOption("Research/Beta/Project.md");
  await expect(input).toHaveValue(beta);
  await page.screenshot({ path: testInfo.outputPath("separate-project-drafts.png") });
  expect(await rig.providerRequests()).toBe(2);
});

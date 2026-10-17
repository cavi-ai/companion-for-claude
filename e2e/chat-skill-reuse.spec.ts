import { expect, test } from "./fixtures";

test("skill reuse keeps the invocation, draft protection, and vault search after reload", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false,
      context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false },
    },
    extraFiles: {
      "Notes/Pilot.md": "# Pilot\n\nFour participants tried a checklist without a control group.\n",
      "Notes/Release.md": "# Release\n\nConfirm the release owner and deadline.\n",
    },
    providerReply: [{ match: ".", replies: ["The links can be reviewed before applying changes."] }],
  });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  const original = "/wikilink-weaver Notes/Pilot.md";
  const next = "/wikilink-weaver Notes/Release.md";
  await input.fill(original);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  const first = chat.locator(".cc-user").first();
  await expect(first.locator(".cc-command-chip")).toHaveText(original);
  await expect(first.locator(".cc-context-note")).toContainText("search match");
  await first.getByRole("button", { name: "Use again", exact: true }).click();
  await expect(input).toHaveValue(original);
  await page.screenshot({ path: testInfo.outputPath("editable-skill-invocation.png") });

  await input.fill("My unfinished question");
  await first.getByRole("button", { name: "Use again", exact: true }).click();
  const modal = page.locator(".modal").filter({ hasText: "Replace current draft?" });
  await modal.getByRole("button", { name: "Keep draft", exact: true }).click();
  await expect(input).toHaveValue("My unfinished question");
  await first.getByRole("button", { name: "Use again", exact: true }).click();
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(input).toHaveValue(original);

  await input.fill(next);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  const last = chat.locator(".cc-user").last();
  await expect(last.locator(".cc-command-chip")).toHaveText(next);
  await expect(last.locator(".cc-context-note")).toContainText("search match");
  expect(await rig.providerRequests()).toBe(2);

  await rig.reloadPlugin();
  await expect(last.locator(".cc-command-chip")).toHaveText(next);
  await last.getByRole("button", { name: "Use again", exact: true }).click();
  await expect(input).toHaveValue(next);
  await expect(last.locator(".cc-context-note")).toContainText("search match");
  await last.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("# Skill: Wikilink weaver");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("# Task\n\nNotes/Release.md");
  expect(await rig.providerRequests()).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("resumed-skill-invocation-and-context.png") });
});

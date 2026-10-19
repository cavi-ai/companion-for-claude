import { expect, test } from "./fixtures";

test("saved replies retain their own context after later turns and reload", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false, autoTagOnSave: false,
      context: { activeNote: true, selection: false, linkedNotes: false, searchVault: false },
    },
    extraFiles: { "Notes/Pilot.md": "# Pilot\n\nFour participants.", "Notes/Follow-up.md": "# Follow-up\n\nRecruit more participants." },
    providerReply: [{ match: ".", replies: ["The findings remain preliminary."] }],
  });
  const openNote = async (path: string) => {
    const note = page.locator(`.nav-file-title[data-path="${path}"]`);
    if (!await note.isVisible()) await page.locator('.nav-folder-title[data-path="Notes"]').click();
    await note.dblclick();
  };
  await openNote("Notes/Pilot.md");
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  const send = async () => {
    const count = await chat.locator(".cc-assistant").count();
    await chat.locator(".cc-input").fill("Summarize the current note");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant")).toHaveCount(count + 1);
    await expect(chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  };
  const readSaved = async () => page.evaluate(async () => {
    const app = (window as unknown as { app: { workspace: { getActiveFile(): { path: string } }; vault: { cachedRead(file: unknown): Promise<string> } } }).app;
    const file = app.workspace.getActiveFile();
    return { path: file.path, text: await app.vault.cachedRead(file) };
  });
  await send();
  await expect(chat.locator(".cc-context-note").first()).toContainText("active note: Notes/Pilot.md");
  await openNote("Notes/Follow-up.md");
  await send();
  await expect(chat.locator(".cc-context-note").last()).toContainText("active note: Notes/Follow-up.md");
  await chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true }).click();
  await expect.poll(async () => (await readSaved()).text).toContain("## Context provided");
  const latest = await readSaved();
  expect(latest.text).toContain("Notes/Follow-up.md");
  expect(latest.text).not.toContain("Notes/Pilot.md");
  await rig.reloadPlugin();
  await chat.locator(".cc-assistant").first().getByRole("button", { name: "Save as note", exact: true }).click();
  await expect.poll(async () => (await readSaved()).path).not.toBe(latest.path);
  const older = await readSaved();
  expect(older.text).toContain("The findings remain preliminary.");
  expect(older.text).toContain("[active note: Notes/Pilot.md]");
  expect(older.text).not.toContain("Notes/Follow-up.md");
  await expect.poll(() => page.evaluate((path) => {
    const app = (window as unknown as { app: { metadataCache: { resolvedLinks: Record<string, Record<string, number>> } } }).app;
    return Object.keys(app.metadataCache.resolvedLinks[path] ?? {});
  }, older.path)).toContain("Notes/Pilot.md");
  await page.screenshot({ path: testInfo.outputPath("saved-reply-with-original-context.png") });
  expect(await rig.providerRequests()).toBe(2);
});

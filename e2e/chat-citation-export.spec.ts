import { expect, test } from "./fixtures";

type VaultWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  fileManager: { renameFile(file: unknown, path: string): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string>; delete(file: unknown): Promise<void> };
  workspace: { getActiveFile(): { path: string }; getLeaf(value: boolean): { openFile(file: unknown): Promise<void> } };
  metadataCache: { resolvedLinks: Record<string, Record<string, number>> };
} };

test("reply exports follow renamed sources across reload without changing the conversation", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, autoTagOnSave: false, context: { activeNote: true, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Notes/Alpha.md": "# Alpha\n\n## Findings\n\nStarted in March.", "Notes/Destination.md": "# Destination\n\n" },
    providerReply: [{ match: ".", replies: ["Started in March [[Notes/Alpha.md#Findings|the findings]]."] }],
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const open = async (path: string) => page.evaluate(async path => {
    const app = (window as unknown as VaultWindow).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(path));
  }, path);
  await open("Notes/Alpha.md");
  await page.evaluate(async () => { await (window as unknown as VaultWindow).app.commands.executeCommandById("claude-companion:open-chat"); });
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("When did this start?");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  const reply = chat.locator(".cc-assistant").last();
  await expect(reply.locator(".cc-provenance")).toContainText("Started in March.");
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Notes/Alpha.md"), "Notes/Migration.md");
  });
  await rig.reloadPlugin();
  await expect(reply.locator(".cc-provenance-link")).toContainText("Migration");
  await reply.getByRole("button", { name: "Save as note", exact: true }).click();
  const saved = async () => page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    const file = app.workspace.getActiveFile();
    return { path: file.path, text: await app.vault.cachedRead(file) };
  });
  await expect.poll(async () => (await saved()).path).toMatch(/^Claude\/Chats\//);
  const note = await saved();
  expect(note.text).toContain("[[Notes/Migration.md#Findings|the findings]]");
  expect(note.text).toContain("[active note: Notes/Alpha.md](../../Notes/Migration.md)");
  await expect.poll(() => page.evaluate(path => Object.keys((window as unknown as VaultWindow).app.metadataCache.resolvedLinks[path] ?? {}), note.path)).toContain("Notes/Migration.md");
  await reply.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Started in March [[Notes/Migration.md#Findings|the findings]].");
  await open("Notes/Destination.md");
  await reply.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(async () => (await saved()).text).toContain("[[Notes/Migration.md#Findings|the findings]]");
  expect(await reply.locator(".cc-body .internal-link").getAttribute("data-href")).toBe("Notes/Alpha.md#Findings");
  await page.screenshot({ path: testInfo.outputPath("exported-citation-after-rename.png") });
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.vault.delete(app.vault.getAbstractFileByPath("Notes/Migration.md"));
  });
  await reply.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Started in March the findings (source unavailable).");
  expect(errors).toEqual([]);
});

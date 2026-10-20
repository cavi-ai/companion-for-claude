import { expect, test } from "./fixtures";

type VaultWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  fileManager: { renameFile(file: unknown, path: string): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; rename(file: unknown, path: string): Promise<void>; modify(file: unknown, content: string): Promise<void>; delete(file: unknown): Promise<void> };
  workspace: { getActiveFile(): { path: string } | null; getLeaf(value: boolean): { openFile(file: unknown): Promise<void> } };
} };

for (const qualified of [false, true]) {
  test(`${qualified ? "qualified" : "short"} citation links follow source moves across reload and never recreate a deleted source`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, autoTagOnSave: false },
      extraFiles: { "Notes/Alpha.md": "# Alpha\n\n## Findings\n\nStarted in March." },
      providerReply: [{ match: ".", replies: [`Started in March [[${qualified ? "Notes/Alpha.md" : "Alpha"}#Findings]].`] }],
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(async () => {
      const app = (window as unknown as VaultWindow).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Notes/Alpha.md"));
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root");
    await chat.locator(".cc-input").fill("When did this start?");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    const reply = chat.locator(".cc-assistant").last();
    const footer = reply.locator(".cc-provenance");
    await expect(footer).toContainText("Started in March.");
    await page.evaluate(async () => {
      const app = (window as unknown as VaultWindow).app;
      await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Notes/Alpha.md"), "Notes/Migration.md");
    });
    await expect(footer.locator(".cc-provenance-link")).toContainText("Migration › Findings");
    await reply.locator(".cc-body .internal-link").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as VaultWindow).app.workspace.getActiveFile()?.path)).toBe("Notes/Migration.md");
    expect(await page.evaluate(() => Boolean((window as unknown as VaultWindow).app.vault.getAbstractFileByPath("Notes/Alpha.md")))).toBe(false);
    await page.evaluate(async () => {
      const app = (window as unknown as VaultWindow).app;
      await app.vault.rename(app.vault.getAbstractFileByPath("Notes"), "Archive");
    });
    await rig.reloadPlugin();
    await expect(footer.locator(".cc-provenance-link")).toContainText("Migration › Findings");
    await footer.locator(".cc-provenance-link").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as VaultWindow).app.workspace.getActiveFile()?.path)).toBe("Archive/Migration.md");
    await page.screenshot({ path: testInfo.outputPath("renamed-citation-after-reopen.png") });
    await page.evaluate(async () => {
      const app = (window as unknown as VaultWindow).app;
      await app.vault.modify(app.vault.getAbstractFileByPath("Archive/Migration.md"), "# Migration\n\n## Results\n\nStarted in April.");
    });
    await expect(footer).toContainText("Section not found");
    await expect(footer).not.toContainText("Started in March.");
    await page.evaluate(async () => {
      const app = (window as unknown as VaultWindow).app;
      await app.vault.delete(app.vault.getAbstractFileByPath("Archive/Migration.md"));
    });
    await expect(footer).toContainText("Not in vault");
    await expect(footer.locator(".cc-provenance-link")).toHaveCount(0);
    await reply.locator(".cc-body .internal-link").click();
    await expect(page.locator(".notice")).toContainText("Cited note is no longer in the vault.");
    expect(await page.evaluate(() => ["Notes/Alpha.md", "Notes/Migration.md", "Archive/Migration.md"].map(path => Boolean((window as unknown as VaultWindow).app.vault.getAbstractFileByPath(path))))).toEqual([false, false, false]);
    await expect(reply).toContainText("Not in vault");
    await page.screenshot({ path: testInfo.outputPath("missing-citation-without-created-note.png") });
    expect(errors).toEqual([]);
  });
}

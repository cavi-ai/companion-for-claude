import { expect, test } from "./fixtures";

const ALPHA = "# Alpha\n\n## Findings\n\nThe migration started in March and finished in May.\n\n## Open questions\n\nWho owns the rollback?";
const REPLY = "The migration started in March [[Alpha#Findings]]. Nobody has claimed the rollback [[Ghost]].";

type PageApp = {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown };
  workspace: { getActiveFile(): { path: string } | null; getLeaf(newLeaf: boolean): { openFile(file: unknown): Promise<void> } };
};

test("a reply's cited notes are checked against the vault and open at the cited section", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: {
      agentModeEnabled: false, autoTagOnSave: false,
      context: { activeNote: true, selection: false, linkedNotes: false, searchVault: false },
    },
    extraFiles: { "Notes/Alpha.md": ALPHA, "Notes/Other.md": "# Other" },
    providerReply: [
      { match: "so the reader can open the passage", replies: [REPLY] },
      { match: ".", replies: ["No citation rule was sent."] },
    ],
  });
  const openNote = async (path: string) => {
    await expect.poll(() => page.evaluate((p) => Boolean((window as unknown as { app: PageApp }).app.vault.getAbstractFileByPath(p)), path), { timeout: 15_000 }).toBe(true);
    await page.evaluate(async (p) => {
      const app = (window as unknown as { app: PageApp }).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(p));
    }, path);
    await expect.poll(() => page.evaluate(() => (window as unknown as { app: PageApp }).app.workspace.getActiveFile()?.path)).toBe(path);
  };
  await openNote("Notes/Alpha.md");
  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:open-chat"));
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("When did the migration start?");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();

  const reply = chat.locator(".cc-assistant").last();
  await expect(reply).toContainText("The migration started in March");
  const checkFooter = async () => {
    const footer = chat.locator(".cc-assistant").last().locator(".cc-provenance");
    await expect(footer).toBeVisible();
    const items = footer.locator(".cc-provenance-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Alpha › Findings");
    await expect(items.nth(0)).toContainText("The migration started in March and finished in May.");
    await expect(items.nth(0)).not.toHaveClass(/is-missing/);
    await expect(items.nth(1)).toContainText("Ghost");
    await expect(items.nth(1)).toContainText("Not in vault");
    await expect(items.nth(1)).toHaveClass(/is-missing/);
    return items;
  };
  await checkFooter();
  await reply.screenshot({ path: testInfo.outputPath("cited-notes.png") });

  await rig.reloadPlugin();
  const items = await checkFooter();
  await openNote("Notes/Other.md");
  await items.nth(0).locator(".cc-provenance-link").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { app: PageApp }).app.workspace.getActiveFile()?.path)).toBe("Notes/Alpha.md");
});

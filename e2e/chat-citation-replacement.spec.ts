import { expect, test } from "./fixtures";

type VaultWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; delete(file: unknown): Promise<void>; create(path: string, text: string): Promise<unknown>; cachedRead(file: unknown): Promise<string> };
  workspace: { getLeaf(value: boolean): { openFile(file: unknown): Promise<void> } };
} };

test("a reopened citation does not attach to a replacement for a deleted source", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, autoTagOnSave: false },
    extraFiles: { "Notes/Alpha.md": "# Alpha\n\n## Findings\n\nStarted in March." },
    providerReply: [{ match: ".", replies: ["Started in March [[Notes/Alpha.md#Findings]]."] }],
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Notes/Alpha.md"));
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("When did this start? Cite its findings.");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  const reply = chat.locator(".cc-assistant").last();
  const footer = reply.locator(".cc-provenance");
  await expect(footer).toContainText("Started in March.");
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.vault.delete(app.vault.getAbstractFileByPath("Notes/Alpha.md"));
  });
  await expect(footer).toContainText("Not in vault");
  await page.evaluate(async () => {
    await (window as unknown as VaultWindow).app.vault.create("Notes/Alpha.md", "# A different project\n\n## Findings\n\nStarted in November.");
  });
  await rig.reloadPlugin();
  await expect(reply.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("deleted-source-replacement-after-reopen.png") });
  await expect(footer).toContainText("Not in vault");
  await expect(footer).not.toContainText("Started in November.");
  await expect(footer.locator(".cc-provenance-link")).toHaveCount(0);
  await reply.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("source unavailable");
  await reply.locator(".cc-body .internal-link").click();
  await expect(page.locator(".notice").filter({ hasText: "Cited note is no longer in the vault." })).toBeVisible();
  expect(await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    return app.vault.cachedRead(app.vault.getAbstractFileByPath("Notes/Alpha.md"));
  })).toContain("Started in November.");
  expect(errors).toEqual([]);
});

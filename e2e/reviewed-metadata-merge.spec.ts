import { expect, test } from "./fixtures";

const BODY = "# Garden draft\n\nWater plants in the morning.\n";
const ORIGINAL = `---\ntags:\n  - keep\n  - remove-me\n---\n${BODY}`;
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string>; append(file: unknown, text: string): Promise<void> };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null };
  fileManager: { processFrontMatter(file: unknown, edit: (fm: Record<string, unknown>) => void): Promise<void> };
} };

for (const action of ["Tidy", "frontmatter"] as const) {
  test(`${action} merges only reviewed additions into the current metadata`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ extraFiles: { "Garden draft.md": ORIGINAL }, providerReply: [{ match: "/./", replies: ["TITLE: Garden draft\nTYPE: concept\nTAGS: keep, suggested\nSUMMARY: Generated garden summary."] }] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const read = () => page.evaluate(() => { const { vault } = (window as unknown as AppWindow).app; return vault.read(vault.getAbstractFileByPath("Garden draft.md")); });
    const modal = page.locator(".modal");
    await page.evaluate(() => (window as unknown as AppWindow).app.workspace.openLinkText("Garden draft", "", false));
    const propose = async () => {
      if (action === "Tidy") {
        await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:enrich-note"));
        for (const name of ["Rename note", "Add wikilinks", "Lint note"]) await modal.locator(".setting-item").filter({ hasText: name }).locator(".checkbox-container").click();
        await modal.getByRole("button", { name: "Tidy", exact: true }).click();
        await expect(modal.locator(".cc-organize-row")).toContainText("suggested");
      } else {
        await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:open-chat"));
        await page.locator(".cc-chat-root textarea").fill("/frontmatter");
        await page.locator(".cc-chat-root textarea").press("Enter");
        await expect(page.locator(".cc-fm-modal")).toContainText("merges additively");
      }
      await expect(modal).toContainText("Generated garden summary.");
    };
    await propose();
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await read()).toBe(ORIGINAL);
    await propose();
    const currentTags = action === "Tidy" ? ["keep", "user-added"] : "user-added";
    await page.evaluate(async (tags) => {
      const { vault, fileManager } = (window as unknown as AppWindow).app;
      const file = vault.getAbstractFileByPath("Garden draft.md");
      await fileManager.processFrontMatter(file, (fm) => { fm.tags = tags; fm.summary = "My newer summary."; fm.type = "person"; fm.keep = "unrelated edit"; });
      await vault.append(file, "\nAdded while reviewing.\n");
    }, currentTags);
    await page.screenshot({ path: testInfo.outputPath(`${action}-metadata-before-apply.png`), animations: "disabled" });
    await modal.getByRole("button", { name: action === "Tidy" ? "Apply selected" : "Apply", exact: true }).click();
    await expect(page.locator(".notice").filter({ hasText: action === "Tidy" ? "Tidied Garden draft." : "Frontmatter updated: Garden draft" })).toBeVisible();
    const expectedTags = action === "Tidy" ? ["keep", "user-added", "suggested"] : ["user-added", "suggested"];
    await expect.poll(() => page.evaluate(() => { const app = (window as unknown as AppWindow).app; return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Garden draft.md"))?.frontmatter; })).toMatchObject({ tags: expectedTags, summary: "My newer summary.", type: "person", keep: "unrelated edit" });
    const content = await read();
    expect(content).toContain(BODY);
    expect(content).toContain("Added while reviewing.");
    expect(content).not.toContain("remove-me");
    expect(content).not.toContain("Generated garden summary.");
    expect(errors).toEqual([]);
  });
}

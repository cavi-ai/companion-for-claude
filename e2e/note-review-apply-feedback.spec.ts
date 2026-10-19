import { expect, test } from "./fixtures";

const ORIGINAL = "# Apply note\n\nOriginal body.\n";
const REPLACEMENT = "# A different note\n\nReplacement body.\n";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string>; delete(file: unknown): Promise<void>; create(path: string, content: string): Promise<unknown> };
  plugins: { plugins: Record<string, { activity: { snapshot(): { records: Array<{ title: string; state: string; technicalDetails?: string }> } } }> };
} };

for (const action of ["Tidy", "frontmatter"] as const) {
  for (const replaced of [false, true]) {
    test(`${action} reports apply failure after a note is ${replaced ? "replaced" : "removed"} and allows a fresh review`, async ({ rig }, testInfo) => {
      const { page } = await rig.reset({ extraFiles: { "Apply note.md": ORIGINAL }, providerReply: [{ match: "/./", replies: ["TITLE: Apply note\nTYPE: concept\nTAGS: reviewed\nSUMMARY: A reviewed summary."] }] });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const read = () => page.evaluate(() => { const { vault } = (window as unknown as AppWindow).app; const file = vault.getAbstractFileByPath("Apply note.md"); return file ? vault.read(file) : null; });
      const records = () => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.activity.snapshot().records.filter(({ title }) => title.startsWith("Tidying") || title.startsWith("Suggesting frontmatter")));
      const modal = page.locator(".modal");
      const propose = async () => {
        await page.evaluate(() => (window as unknown as AppWindow).app.workspace.openLinkText("Apply note", "", false));
        if (action === "Tidy") {
          await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:enrich-note"));
          for (const name of ["Rename note", "Add wikilinks", "Lint note"]) await modal.locator(".setting-item").filter({ hasText: name }).locator(".checkbox-container").click();
          await modal.getByRole("button", { name: "Tidy", exact: true }).click();
          await expect(modal.locator(".cc-organize-row")).toContainText("reviewed");
        } else {
          await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:open-chat"));
          await page.locator(".cc-chat-root textarea").fill("/frontmatter");
          await page.locator(".cc-chat-root textarea").press("Enter");
          await expect(page.locator(".cc-fm-modal")).toBeVisible();
        }
      };
      const apply = () => modal.getByRole("button", { name: action === "Tidy" ? "Apply selected" : "Apply", exact: true }).click();
      await propose();
      expect((await records()).some(({ state }) => state === "running")).toBe(true);
      await page.evaluate(async (replace) => { const { vault } = (window as unknown as AppWindow).app; await vault.delete(vault.getAbstractFileByPath("Apply note.md")); if (replace) await vault.create("Apply note.md", "# A different note\n\nReplacement body.\n"); }, replaced);
      await apply();
      const failure = page.locator(".notice").filter({ hasText: action === "Tidy" ? "Tidy failed" : "Couldn't apply frontmatter" });
      await expect(failure).toContainText("This note is no longer available");
      await expect(failure).toContainText("Reopen the note and try again");
      expect(await read()).toBe(replaced ? REPLACEMENT : null);
      expect(await records()).toMatchObject([{ state: "needs-attention", technicalDetails: expect.stringContaining("no longer available") }]);
      await page.screenshot({ path: testInfo.outputPath(`${action}-${replaced ? "replaced" : "removed"}-feedback.png`), animations: "disabled" });
      if (!replaced) await page.evaluate(async () => { await (window as unknown as AppWindow).app.vault.create("Apply note.md", "# Apply note\n\nOriginal body.\n"); });
      await propose();
      await apply();
      await expect(page.locator(".notice").filter({ hasText: action === "Tidy" ? "Tidied Apply note." : "Frontmatter updated: Apply note" })).toBeVisible();
      expect(await read()).toContain(replaced ? REPLACEMENT : ORIGINAL);
      expect(await read()).toContain("reviewed");
      expect((await records()).some(({ state }) => state === "running")).toBe(false);
      expect((await records()).some(({ state }) => state === "succeeded")).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}

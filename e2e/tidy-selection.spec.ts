import { expect, test } from "./fixtures";

const ORIGINAL = "# Garden draft\n\nWater plants in the morning.\n";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null };
} };

for (const accepted of ["rename", "metadata"] as const) {
  test(`Tidy names its controls and applies only accepted ${accepted}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ extraFiles: { "Garden draft.md": ORIGINAL }, providerReply: [{ match: "precise knowledge-base indexer", replies: ["TITLE: Garden schedule\nTAGS: gardening, watering\nSUMMARY: When to water garden plants."] }] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const read = (path: string) => page.evaluate(async (value) => { const { vault } = (window as unknown as AppWindow).app; const file = vault.getAbstractFileByPath(value); return file ? vault.read(file) : null; }, path);
    const open = () => page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:enrich-note"));
    const modal = page.locator(".modal");
    await page.evaluate(() => (window as unknown as AppWindow).app.workspace.openLinkText("Garden draft", "", false));
    await open();
    for (const name of ["Rename note", "Tags & summary", "Add wikilinks", "Lint note"]) await expect(modal.getByRole("switch", { name, exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(modal.getByRole("checkbox")).toHaveCount(0);
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await rig.providerRequests()).toBe(0);
    expect(await read("Garden draft.md")).toBe(ORIGINAL);
    const propose = async () => {
      await open();
      for (const name of ["Add wikilinks", "Lint note"]) {
        const toggle = modal.getByRole("switch", { name, exact: true });
        await toggle.focus();
        await toggle.press("Space");
        await expect(toggle).toHaveAttribute("aria-checked", "false");
      }
      await modal.getByRole("button", { name: "Tidy", exact: true }).click();
      await expect(modal.getByRole("checkbox", { name: "Rename → Garden schedule.md", exact: true })).toBeChecked();
      await expect(modal.getByRole("checkbox", { name: /Frontmatter.*gardening/ })).toBeChecked();
    };
    await propose();
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await read("Garden draft.md")).toBe(ORIGINAL);
    expect(await read("Garden schedule.md")).toBeNull();
    await propose();
    const rejected = accepted === "rename" ? "Frontmatter" : "Rename";
    const row = modal.locator(".cc-organize-row").filter({ hasText: rejected });
    await row.locator(".cc-organize-from").click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
    await row.getByRole("checkbox").focus();
    await row.getByRole("checkbox").press("Space");
    await expect(row.getByRole("checkbox")).toBeChecked();
    await row.locator(".cc-organize-to").click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`tidy-select-${accepted}.png`), animations: "disabled" });
    await modal.getByRole("button", { name: "Apply selected", exact: true }).click();
    await expect(page.locator(".notice").filter({ hasText: "Tidied" })).toBeVisible();
    if (accepted === "rename") {
      expect(await read("Garden draft.md")).toBeNull();
      expect(await read("Garden schedule.md")).toBe(ORIGINAL);
    } else {
      expect(await read("Garden schedule.md")).toBeNull();
      const content = await read("Garden draft.md");
      expect(content).toContain(ORIGINAL);
      await expect.poll(() => page.evaluate(() => { const app = (window as unknown as AppWindow).app; return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Garden draft.md"))?.frontmatter; })).toMatchObject({ tags: ["gardening", "watering"], summary: "When to water garden plants." });
    }
    expect(await rig.providerRequests()).toBe(2);
    expect(errors).toEqual([]);
  });
}

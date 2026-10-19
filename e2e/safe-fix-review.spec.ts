import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  plugins: { plugins: Record<string, { ontology(): { load(): Promise<unknown> } }> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string>; delete(file: unknown): Promise<void> };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null };
  fileManager: { processFrontMatter(file: unknown, edit: (fm: Record<string, unknown>) => void): Promise<void> };
} };

test("safe-fix review names choices and preserves changed or removed notes", async ({ rig }, testInfo) => {
  const titles = ["Changed note", "Unchanged note", "Excluded note", "Removed note"];
  const notes = Object.fromEntries(titles.map((title) => [`${title}.md`, `---\ntype: review-example\naliases: initial\n---\n# ${title}\n\nOriginal body.\n`]));
  const { page } = await rig.reset({ settingsOverride: { ontologyEnabled: true }, extraFiles: {
    ...notes,
    "Ontology/Review example.md": "---\nontology: type\ntype_name: review-example\n---\n```yaml\nproperties:\n  - key: aliases\n    type: string[]\n```\n",
  } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = (path: string) => page.evaluate(async (value) => { const { vault } = (window as unknown as AppWindow).app; const file = vault.getAbstractFileByPath(value); return file ? vault.read(file) : null; }, path);
  await expect.poll(() => page.evaluate(() => { const app = (window as unknown as AppWindow).app; return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Changed note.md"))?.frontmatter?.aliases; })).toBe("initial");
  await expect.poll(() => page.evaluate(() => { const app = (window as unknown as AppWindow).app; return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Ontology/Review example.md"))?.frontmatter?.ontology; })).toBe("type");
  await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.plugins.plugins["claude-companion"]!.ontology().load(); app.commands.executeCommandById("claude-companion:open-system"); });
  await page.locator(".cc-system-view").getByRole("button", { name: "Refresh", exact: true }).click();
  const open = page.getByRole("button", { name: "Review safe fixes (4)", exact: true });
  await open.click();
  const modal = page.locator(".cc-safe-fix-review");
  await expect(modal.getByRole("checkbox")).toHaveCount(4);
  for (const title of titles) await expect(modal.getByRole("checkbox", { name: `${title}.md aliases: "initial" → ["initial"]`, exact: true })).toBeChecked();
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const [path, content] of Object.entries(notes)) expect(await read(path)).toBe(content);
  await open.click();
  const excluded = modal.locator(".cc-safe-fix-row").filter({ hasText: "Excluded note.md" });
  await excluded.locator(".cc-safe-fix-path").click();
  await expect(excluded.getByRole("checkbox")).not.toBeChecked();
  await excluded.getByRole("checkbox").focus();
  await excluded.getByRole("checkbox").press("Space");
  await expect(excluded.getByRole("checkbox")).toBeChecked();
  await excluded.locator(".cc-safe-fix-change").click();
  await expect(excluded.getByRole("checkbox")).not.toBeChecked();
  await page.evaluate(async () => {
    const { vault, fileManager } = (window as unknown as AppWindow).app;
    await fileManager.processFrontMatter(vault.getAbstractFileByPath("Changed note.md"), (fm) => { fm.aliases = ["new-choice"]; fm.reviewed = true; });
    await fileManager.processFrontMatter(vault.getAbstractFileByPath("Unchanged note.md"), (fm) => { fm.keep = "unrelated edit"; });
    await vault.delete(vault.getAbstractFileByPath("Removed note.md"));
  });
  const changed = await read("Changed note.md");
  await modal.getByRole("button", { name: "Apply selected", exact: true }).click();
  const notice = page.locator(".notice").filter({ hasText: "Applied 1 of 3 selected fixes" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Changed note.md: This note changed since review");
  await expect(notice).toContainText("Removed note.md: This note no longer exists");
  await page.screenshot({ path: testInfo.outputPath("changed-notes-preserved.png"), animations: "disabled" });
  expect(await read("Changed note.md")).toBe(changed);
  expect(await read("Excluded note.md")).toBe(notes["Excluded note.md"]);
  expect(await read("Removed note.md")).toBeNull();
  expect(await read("Unchanged note.md")).toContain("# Unchanged note\n\nOriginal body.\n");
  await expect.poll(() => page.evaluate(() => { const app = (window as unknown as AppWindow).app; return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Unchanged note.md"))?.frontmatter; })).toMatchObject({ aliases: ["initial"], keep: "unrelated edit" });
  await expect(page.getByRole("button", { name: "Review safe fixes (1)", exact: true })).toBeVisible();
  expect(await rig.providerRequests()).toBe(0);
  expect(errors).toEqual([]);
});

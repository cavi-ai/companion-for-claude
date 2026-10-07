import { expect, test } from "./fixtures";

const NOTES: Record<string, string> = {
  "Projects/Alpha.md": "---\ntype: project\n---\nAlpha body.",
  "Projects/Beta.md": "---\ntype: project\n---\nBeta body.",
  "Projects/Gamma.md": "---\ntype: project\n---\nGamma body.",
  "Projects/New idea.md": "A loose idea with no frontmatter.",
};

type PageApp = {
  vault: {
    create(path: string, content: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    getAbstractFileByPath(path: string): unknown;
    adapter: { read(path: string): Promise<string> };
  };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: { type?: unknown } } | null };
  commands: { executeCommandById(id: string): Promise<void> };
};

test("type an untyped note from its folder: the folder row is checked and Apply writes only the type", async ({ rig }) => {
  const { page } = await rig.reset();
  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:seed-ontology"));
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { app: PageApp }).app.vault.getAbstractFileByPath("Ontology/project.md"))), { timeout: 15_000 }).toBe(true);

  await page.evaluate(async (notes) => {
    const app = (window as unknown as { app: PageApp }).app;
    for (const [path, content] of Object.entries(notes)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, content);
    }
  }, NOTES);

  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app: PageApp }).app;
    return ["Alpha", "Beta", "Gamma"].every((name) => app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(`Projects/${name}.md`))?.frontmatter?.type === "project");
  }), { timeout: 15_000 }).toBe(true);

  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:optimize-types"));
  const modal = page.locator(".cc-type-weave-review");
  await expect(modal).toBeVisible();

  const row = modal.locator(".setting-item", { hasText: "Projects/New idea.md" });
  await expect(row).toContainText("folder: 3 of 3 typed notes in Projects/ are project");
  await expect(row.locator("input[type=checkbox]")).toBeChecked();
  await modal.getByRole("button", { name: "Apply selected" }).click();

  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app: PageApp }).app;
    return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Projects/New idea.md"))?.frontmatter?.type;
  }), { timeout: 15_000 }).toBe("project");

  const written = await page.evaluate(() => (window as unknown as { app: PageApp }).app.vault.adapter.read("Projects/New idea.md"));
  expect(written).toMatch(/^---\ntype: "?project"?\n---\n/);
  expect(written).toContain("A loose idea with no frontmatter.");
});

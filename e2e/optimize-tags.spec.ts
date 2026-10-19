import { expect, test } from "./fixtures";

const NOTES: Record<string, string> = {
  "Tags/One.md": "---\ntags: [machine-learning]\n---\nOne.",
  "Tags/Two.md": "---\ntags: [machine-learning]\n---\nTwo.",
  "Tags/Three.md": "---\ntags: [machine-learning]\n---\nThree.",
  "Tags/Four.md": "---\ntags: [machine_learning]\n---\nFour.",
  "Tags/Five.md": "---\ntags: [ui-automation]\n---\nFive.",
  "Tags/Six.md": "---\ntags: [ui-automation]\n---\nSix.",
  "Tags/Seven.md": "---\ntags: [gui-automation]\n---\nSeven.",
};

type PageApp = {
  vault: { getAbstractFileByPath(path: string): unknown };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: { tags?: unknown } } | null };
  commands: { executeCommandById(id: string): Promise<void> };
};

const tagsOf = (path: string) => (window as unknown as { app: PageApp }).app.metadataCache.getFileCache(
  (window as unknown as { app: PageApp }).app.vault.getAbstractFileByPath(path),
)?.frontmatter?.tags;

test("a spelling-variant merge is offered checked and applied; a typo pair waits for the model check", async ({ rig }) => {
  const { page } = await rig.reset({ extraFiles: NOTES });
  await expect.poll(() => page.evaluate(tagsOf, "Tags/Four.md"), { timeout: 15_000 }).toEqual(["machine_learning"]);
  await expect.poll(() => page.evaluate(tagsOf, "Tags/Seven.md"), { timeout: 15_000 }).toEqual(["gui-automation"]);

  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:optimize-brain"));
  const modal = page.locator(".cc-optimize-review");
  await expect(modal).toBeVisible();

  const row = modal.locator(".setting-item", { hasText: "machine_learning (1) → machine-learning (3)" });
  await expect(row).toHaveClass(/mod-toggle/);
  await expect(row.locator(".checkbox-container")).toHaveClass(/is-enabled/);
  await expect(modal).not.toContainText("gui-automation");
  await expect(modal).toContainText("offered only if Check with model says they are the same tag.");

  await modal.getByRole("button", { name: "Apply selected" }).click();
  await expect.poll(() => page.evaluate(tagsOf, "Tags/Four.md"), { timeout: 15_000 }).toEqual(["machine-learning"]);
  expect(await page.evaluate(tagsOf, "Tags/Seven.md")).toEqual(["gui-automation"]);
});

import { expect, test } from "./fixtures";

const NOTES: Record<string, string> = {
  "Orphans/Zephyr Quill.md": "Shared body text for the related row.",
  "Topics/Twin.md": "Shared body text for the related row.",
  "Daily/log.md": "See [[Hub]]. Talked about Zephyr Quill today.",
  "Hub.md": "Index of [[log]] and [[Twin]].",
};

type PageApp = {
  vault: {
    create(path: string, content: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    getAbstractFileByPath(path: string): unknown;
    adapter: { read(path: string): Promise<string> };
  };
  metadataCache: { resolvedLinks: Record<string, Record<string, number>> };
  commands: { executeCommandById(id: string): Promise<void> };
  plugins: { plugins: Record<string, { indexer(): { build(opts: { force: boolean }): Promise<unknown> } | null }> };
};

test("connect an orphan note: the mention becomes a link and the related row adds a frontmatter link", async ({ rig }) => {
  const { page } = await rig.reset({ embedStub: true });
  await page.evaluate(async (notes) => {
    const app = (window as unknown as { app: PageApp }).app;
    for (const [path, content] of Object.entries(notes)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, content);
    }
    await app.plugins.plugins["claude-companion"]!.indexer()!.build({ force: true });
  }, NOTES);

  await expect.poll(() => page.evaluate(() => {
    const links = (window as unknown as { app: PageApp }).app.metadataCache.resolvedLinks;
    return Boolean(links["Hub.md"]?.["Daily/log.md"]) && Boolean(links["Hub.md"]?.["Topics/Twin.md"]);
  }), { timeout: 15_000 }).toBe(true);

  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:optimize-links"));
  const modal = page.locator(".cc-link-weave-review");
  await expect(modal).toBeVisible();

  const inbound = modal.locator(".setting-item", { hasText: "mentioned in: Daily/log.md → Orphans/Zephyr Quill.md" });
  await expect(inbound.locator("input[type=checkbox]")).toBeChecked();
  const related = modal.locator(".setting-item", { hasText: "Orphans/Zephyr Quill.md → Topics/Twin.md" });
  await expect(related.locator("input[type=checkbox]")).not.toBeChecked();
  await related.locator("input[type=checkbox]").check();
  await modal.getByRole("button", { name: "Apply selected" }).click();

  await expect.poll(() => page.evaluate(() => {
    const links = (window as unknown as { app: PageApp }).app.metadataCache.resolvedLinks;
    return {
      inbound: Boolean(links["Daily/log.md"]?.["Orphans/Zephyr Quill.md"]),
      frontmatter: Boolean(links["Orphans/Zephyr Quill.md"]?.["Topics/Twin.md"]),
    };
  }), { timeout: 15_000 }).toEqual({ inbound: true, frontmatter: true });

  const [log, orphan] = await page.evaluate(async () => {
    const app = (window as unknown as { app: PageApp }).app;
    return [await app.vault.adapter.read("Daily/log.md"), await app.vault.adapter.read("Orphans/Zephyr Quill.md")];
  });
  expect(log).toBe("See [[Hub]]. Talked about [[Zephyr Quill]] today.");
  expect(orphan).toMatch(/^---\nrelated:\n\s+- "\[\[Twin\]\]"\n---\n/);
});

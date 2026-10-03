import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const NOTE = "---\ntitle: Hidden title\nprivate: yes\n---\n# Public heading\n\nVisible paragraph %%secret aside%% end.\n";

type PublishedSeam = { key: string; gistId: string; url: string; kind: string };
type AppSeam = {
  app: {
    plugins: { plugins: Record<string, { publishedItems(): PublishedSeam[] }> };
    vault: { getAbstractFileByPath(path: string): unknown; modify(file: unknown, data: string): Promise<void> };
    workspace: { openLinkText(link: string, source: string, newLeaf: boolean): Promise<void> };
    commands: { executeCommandById(id: string): Promise<void> };
  };
};

const runCommand = (page: Page, id: string): Promise<void> =>
  page.evaluate((commandId) => (window as unknown as AppSeam).app.commands.executeCommandById(`claude-companion:${commandId}`), id);

const published = (page: Page): Promise<PublishedSeam[]> =>
  page.evaluate(() => (window as unknown as AppSeam).app.plugins.plugins["claude-companion"]!.publishedItems());

test("a note publishes as a secret gist without frontmatter or comments, republishes in place, and unpublishes", async ({ rig }) => {
  const { githubPort } = await rig.control.ports();
  const harness = await rig.reset({
    extraFiles: { "Publish me.md": NOTE },
    settingsOverride: { publishApiBase: `http://127.0.0.1:${githubPort}`, publishGithubToken: "e2e-gist-token" },
  });
  const { page } = harness;
  try {
    await page.evaluate(() => (window as unknown as AppSeam).app.workspace.openLinkText("Publish me", "", false));

    await runCommand(page, "publish-note");
    const confirm = page.locator(".modal-container").filter({ hasText: "Anyone with the link can read this" });
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.getByRole("button", { name: "Publish", exact: true }).click();

    await expect.poll(async () => (await harness.githubRequests()).length, { timeout: 15_000 }).toBe(1);
    const [created] = await harness.githubRequests();
    expect(created).toMatchObject({ method: "POST", path: "/gists" });
    const body = JSON.parse(created!.body) as { public: boolean; files: Record<string, { content: string }> };
    expect(body.public).toBe(false);
    const content = Object.values(body.files)[0]!.content;
    expect(content).toContain("Visible paragraph");
    expect(content).not.toContain("Hidden title");
    expect(content).not.toContain("private: yes");
    expect(content).not.toContain("secret aside");
    await expect(page.locator(".notice").filter({ hasText: "link copied" })).toBeVisible();
    await expect.poll(() => published(page)).toEqual([expect.objectContaining({ key: "Publish me.md", gistId: "g1", url: "https://gist.github.com/e2e/g1", kind: "note" })]);

    await page.evaluate(async () => {
      const { vault } = (window as unknown as AppSeam).app;
      await vault.modify(vault.getAbstractFileByPath("Publish me.md"), "# Public heading\n\nEdited.\n");
    });
    await runCommand(page, "publish-note");
    await expect.poll(async () => (await harness.githubRequests()).length, { timeout: 15_000 }).toBe(2);
    expect((await harness.githubRequests())[1]).toMatchObject({ method: "PATCH", path: "/gists/g1" });
    await expect(confirm).toHaveCount(0);
    expect(await published(page)).toHaveLength(1);

    await runCommand(page, "unpublish-note");
    await expect.poll(async () => (await harness.githubRequests()).length, { timeout: 15_000 }).toBe(3);
    expect((await harness.githubRequests())[2]).toMatchObject({ method: "DELETE", path: "/gists/g1" });
    await expect.poll(() => published(page)).toEqual([]);
  } finally {
    await harness.close();
  }
});

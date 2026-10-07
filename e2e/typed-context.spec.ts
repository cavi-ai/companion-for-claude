import { expect, test } from "./fixtures";

const NOTES: Record<string, string> = {
  "People/Alice.md": "---\ntype: person\n---\nAlice runs the flight software team.",
  "Projects/Apollo.md": "---\ntype: project\ncontributors: [\"[[Alice]]\"]\n---\nApollo ships the zephyrine guidance module.",
};
const SENTINEL = "typed relation followed: Alice";
const RELATED_RULE = { match: "Related (contributors of Projects/Apollo.md): People/Alice.md", replies: [SENTINEL] };

type PageApp = {
  vault: {
    create(path: string, content: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    getAbstractFileByPath(path: string): unknown;
  };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: { type?: unknown } } | null };
  commands: { executeCommandById(id: string): Promise<void> };
};

test("a vault-search match pulls in its typed relation target through Obsidian's link resolver", async ({ rig }) => {
  const { page } = await rig.reset({
    providerReply: [RELATED_RULE],
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: true } },
  });
  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:seed-ontology"));
  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app: PageApp }).app;
    return Boolean(app.vault.getAbstractFileByPath("Ontology/person.md") && app.vault.getAbstractFileByPath("Ontology/project.md"));
  }), { timeout: 15_000 }).toBe(true);

  await page.evaluate(async (notes) => {
    const app = (window as unknown as { app: PageApp }).app;
    for (const [path, content] of Object.entries(notes)) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, content);
    }
  }, NOTES);
  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app: PageApp }).app;
    const type = (path: string): unknown => app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(path))?.frontmatter?.type;
    return [type("People/Alice.md"), type("Projects/Apollo.md")];
  }), { timeout: 15_000 }).toEqual(["person", "project"]);

  await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:open-chat"));
  const chat = page.locator(".cc-chat-root").first();
  await chat.locator(".cc-input").fill("zephyrine");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText(SENTINEL, { timeout: 30_000 });
});

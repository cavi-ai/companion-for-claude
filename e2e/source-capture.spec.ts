import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const article = "---\n\n## Introduction\n\nA study compares several sources of evidence.\n\nThe task: evaluate their findings.\n\n---\n\n## Methods\n\nPreserve tables, equations, and code examples.  \n";

test("Inbox enrichment prepares an article with a leading separator without losing its body", async ({ rig }, testInfo) => {
  const input = process.env.CC_SOURCE_FIXTURE ? await readFile(process.env.CC_SOURCE_FIXTURE, "utf8") : article;
  const path = "Clippings/Source article.md";
  const { page } = await rig.reset({
    extraFiles: { [path]: input },
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow", semanticEnabled: false },
    providerReply: [{ match: ".", replies: [JSON.stringify({ title: "Evidence study", site: "Example", summary: "A study of evidence." })] }],
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  await inbox.getByRole("button", { name: "Enrich Source article", exact: true }).click();
  await expect(inbox.locator(".cc-inbox-typed")).toContainText("Source article");
  const saved = await readFile(`${rig.paths.vault}/${path}`, "utf8");
  const firstClose = saved.indexOf("\n---\n", 4);
  expect(firstClose).toBeGreaterThan(4);
  expect(saved.slice(firstClose + 5)).toBe(input);
  expect(await rig.providerRequests()).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("enriched-article.png") });
});

test("Clipper setup copies and downloads the same importable JSON and exports .json vault files", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { sourceCaptureEnabled: true, semanticEnabled: false } });
  await page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { clipperSetup(): { openSetup(): void } }> } } }).app.plugins.plugins["claude-companion"]!;
    plugin.clipperSetup().openSetup();
  });
  const modal = page.locator(".cc-clipper-setup-modal");
  const shown = await modal.locator(".cc-clipper-json").textContent();
  expect(JSON.parse(shown!)).toMatchObject({ schemaVersion: "0.1.0", name: "Companion: article", behavior: "create" });
  await modal.getByRole("button", { name: "Copy template JSON", exact: true }).click();
  await expect(modal.locator(".cc-clipper-verification")).toContainText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    modal.getByRole("button", { name: "Save JSON file", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("companion-article-clipper.json");
  expect(await readFile((await download.path())!, "utf8")).toBe(shown);
  await page.evaluate(async () => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { clipperSetup(): { exportTemplates(): Promise<unknown> } }> } } }).app.plugins.plugins["claude-companion"]!;
    await plugin.clipperSetup().exportTemplates();
  });
  expect(await readFile(`${rig.paths.vault}/Claude/Clipper templates/companion-article-clipper.json`, "utf8")).toBe(shown);
  await page.screenshot({ path: testInfo.outputPath("clipper-setup.png") });
});

test("source normalization preserves properties and aliases with the real Obsidian parser", async ({ rig }) => {
  const path = "Clippings/Metadata source.md";
  const body = "\r\n# Body\r\n\r\n```yaml\r\ntype: video\r\n```\r\n";
  const input = "\uFEFF---\r\n# Keep guidance\r\ntitle: Evidence: a study\r\nsite: Example\r\nschema_version: &version 0\r\ncustom: *version\r\ntags:\r\n\t- existing\r\n---\r\n" + body;
  const { page } = await rig.reset({
    extraFiles: { [path]: input },
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow", semanticEnabled: false },
    providerReply: [{ match: ".", replies: [JSON.stringify({ summary: "A study of evidence." })] }],
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  await inbox.getByRole("button", { name: "Enrich Metadata source", exact: true }).click();
  await expect(inbox.locator(".cc-inbox-typed")).toContainText("Metadata source");
  const saved = await readFile(`${rig.paths.vault}/${path}`, "utf8");
  expect(saved.slice(saved.indexOf("\r\n---\r\n", 4) + 7)).toBe(body);
  expect(saved).toContain("# Keep guidance");
  const properties = await page.evaluate((path) => {
    const app = (window as unknown as { app: { vault: { getFileByPath(path: string): unknown }; metadataCache: { getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null } } }).app;
    return app.metadataCache.getFileCache(app.vault.getFileByPath(path))?.frontmatter;
  }, path);
  expect(properties).toMatchObject({ title: "Evidence: a study", custom: 0, schema_version: 1, type: "article" });
  expect(await rig.providerRequests()).toBe(1);
});

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { App } from "obsidian";
import { expect, test } from "./fixtures";
import { assertClipperImportContracts } from "./clipper/importContract";

const article = "---\n\n## Introduction\n\nA study compares several sources of evidence.\n\nThe task: evaluate their findings.\n\n---\n\n## Methods\n\nPreserve tables, equations, and code examples.  \n";

async function sourcePage(hold = false) {
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let respond: (() => void) | undefined;
  const release = () => { const send = respond; respond = undefined; send?.(); };
  const server = createServer((_request, response) => {
    respond = () => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head><title>Evidence study</title></head><body><article><h1>Evidence study</h1><p>Captured evidence compares calibrated measurements across several independent cohorts. This passage records the study methods and results for later review.</p><p>The second passage explains how repeated measurements help distinguish stable observations from sampling noise.</p></article></body></html>");
    };
    started();
    if (!hold) release();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Source page server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/article`,
    requested,
    release,
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

test("Inbox recovery uses url when the source property is blank", async ({ rig }) => {
  const source = await sourcePage();
  const path = "Clippings/Empty source property.md";
  try {
    const { page } = await rig.reset({
      extraFiles: { [path]: `---\ntitle: Evidence study\nsource: " "\nurl: ${source.url}\n---\n` },
      settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow", semanticEnabled: false },
      providerReply: [{ match: ".", replies: [JSON.stringify({ site: "Example", summary: "A study compares calibrated measurements." })] }],
    });
    await page.evaluate(async () => { await (window as unknown as { app: App }).app.commands.executeCommandById("claude-companion:open-source-inbox"); });
    const inbox = page.locator(".cc-inbox-view:visible").first();
    await inbox.getByRole("button", { name: "Enrich Empty source property", exact: true }).click();
    await expect(inbox.locator(".cc-inbox-typed")).toContainText("Empty source property");
    const saved = await readFile(`${rig.paths.vault}/${path}`, "utf8");
    expect(saved).toContain("Captured evidence compares calibrated measurements");
    expect(saved).toContain("source_enriched: true");
    expect(await rig.providerRequests()).toBe(1);
  } finally {
    await source.close();
  }
});

test("Inbox recovery preserves the note when its source URL changes during the page request", async ({ rig }) => {
  const source = await sourcePage(true);
  const path = "Clippings/Changed source URL.md";
  const initial = `---\ntitle: Evidence study\nsource: ${source.url}\n---\n`;
  const changed = initial.replace(source.url, "https://example.com/new-source");
  try {
    const { page } = await rig.reset({
      extraFiles: { [path]: initial },
      settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow", semanticEnabled: false },
      providerReply: [{ match: ".", replies: [JSON.stringify({ site: "Example", summary: "A study compares calibrated measurements." })] }],
    });
    await page.evaluate(async () => { await (window as unknown as { app: App }).app.commands.executeCommandById("claude-companion:open-source-inbox"); });
    const inbox = page.locator(".cc-inbox-view:visible").first();
    await inbox.getByRole("button", { name: "Enrich Changed source URL", exact: true }).click();
    await source.requested;
    await page.evaluate(async ({ path, changed }) => {
      const app = (window as unknown as { app: App }).app;
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error("Source note missing");
      await app.vault.modify(file, changed);
    }, { path, changed });
    source.release();
    await expect(inbox.locator(".cc-inbox-enrichment-error")).toContainText("source URL changed");
    expect(await readFile(`${rig.paths.vault}/${path}`, "utf8")).toBe(changed);
  } finally {
    source.release();
    await source.close();
  }
});

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

test("Clipper setup exports the correct contract for Templates and Properties import", async ({ rig }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = await rig.reset({ settingsOverride: { sourceCaptureEnabled: true, semanticEnabled: false } });
  await page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { clipperSetup(): { openSetup(): void } }> } } }).app.plugins.plugins["claude-companion"]!;
    plugin.clipperSetup().openSetup();
  });
  const modal = page.locator(".cc-clipper-setup-modal");
  const shown = await modal.locator(".cc-clipper-template-json").textContent();
  expect(JSON.parse(shown!)).toMatchObject({ schemaVersion: "0.1.0", name: "Companion: article", behavior: "create" });
  await modal.getByRole("button", { name: "Copy template JSON", exact: true }).click();
  await expect(modal.locator(".cc-clipper-verification")).toContainText("Copied.");
  const copiedTemplate = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedTemplate).toBe(shown);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    modal.getByRole("button", { name: "Save JSON file", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("companion-article-clipper.json");
  const savedTemplate = await readFile((await download.path())!, "utf8");
  expect(savedTemplate).toBe(shown);
  await modal.locator("summary", { hasText: "Properties → Import" }).click();
  await modal.getByRole("button", { name: "Copy property types JSON", exact: true }).click();
  await expect(modal.locator(".cc-clipper-properties-status")).toContainText("Copied property types");
  const copiedProperties = await page.evaluate(() => navigator.clipboard.readText());
  const [propertiesDownload] = await Promise.all([
    page.waitForEvent("download"),
    modal.getByRole("button", { name: "Save property types JSON", exact: true }).click(),
  ]);
  expect(propertiesDownload.suggestedFilename()).toBe("companion-article-properties.json");
  const savedProperties = await readFile((await propertiesDownload.path())!, "utf8");
  expect(savedProperties).toBe(copiedProperties);
  await assertClipperImportContracts(
    { copied: copiedTemplate, saved: savedTemplate, fileName: download.suggestedFilename() },
    { copied: copiedProperties, saved: savedProperties, fileName: propertiesDownload.suggestedFilename() },
  );
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

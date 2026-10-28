import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import { unzipSync } from "fflate";

// Exercise the published importer, including its browser storage and dialogs.
// Both import contracts come from Obsidian Web Clipper 1.7.1.
const RELEASE = "https://github.com/obsidianmd/obsidian-clipper/releases/download/1.7.1/obsidian-web-clipper-1.7.1-chrome.zip";
const SHA256 = "d2ba2ec023ba7a27def2463e3cfd37e8b2619c7f30392c9c12afdf5ac53534d8";

interface ExportedJson {
  copied: string;
  fileName: string;
  saved: string;
}

async function installExtension(root: string): Promise<string> {
  const cache = join(tmpdir(), `obsidian-clipper-${SHA256}.zip`);
  let archive = await readFile(cache).catch(() => null);
  if (!archive) {
    const response = await fetch(RELEASE, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Web Clipper download failed: ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(archive).digest("hex") !== SHA256) throw new Error("Web Clipper release checksum mismatch");
  await writeFile(cache, archive);
  const extension = join(root, "extension");
  await mkdir(extension);
  for (const [name, contents] of Object.entries(unzipSync(archive))) {
    const path = resolve(extension, name);
    if (!path.startsWith(`${extension}${sep}`)) throw new Error("Invalid Web Clipper archive path");
    if (name.endsWith("/")) { await mkdir(path, { recursive: true }); continue; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return extension;
}

/** Real Companion clipboard/download bytes go into the real extension's import UI. */
export async function assertClipperImportContracts(template: ExportedJson, properties: ExportedJson): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "companion-clipper-import-"));
  try {
    const extension = await installExtension(root);
    // Each route gets fresh storage: a successful paste must not mask a broken file import.
    for (const mode of ["copy", "save"] as const) {
      const context = await chromium.launchPersistentContext(join(root, `profile-${mode}`), {
        channel: "chromium", headless: true,
        ...(process.env.CC_CLIPPER_CHROMIUM_PATH ? { executablePath: process.env.CC_CLIPPER_CHROMIUM_PATH } : {}),
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      try {
        // Disable unrelated provider update requests; import and storage stay real.
        await context.route(/^https?:\/\//, (route) => route.abort());
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("console", (message) => { if (message.type() === "error" && message.text().includes("types.json")) errors.push(message.text()); });
        page.on("dialog", (dialog) => {
          // The importer asks before updating an existing, conflicting type.
          void (dialog.type() === "confirm" && dialog.message().includes("has a conflict") ? dialog.accept() : dialog.dismiss());
        });
        await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/settings.html?section=properties`);
        await expect(page.locator("#template-list li").first()).toBeVisible();
        const storage = () => worker.evaluate(async () => {
          const browser = (globalThis as unknown as { chrome: { storage: { sync: { get(keys: string[]): Promise<{ template_list: string[]; property_types: Array<{ name: string; type: string }> }> } } } }).chrome;
          return browser.storage.sync.get(["template_list", "property_types"]);
        });
        const importJson = async (artifact: ExportedJson, mode: "copy" | "save"): Promise<void> => {
          const modal = page.locator("#import-modal");
          await expect(modal).toBeVisible();
          if (mode === "copy") {
            await modal.locator(".import-json-textarea").fill(artifact.copied);
            await modal.locator(".import-confirm-btn").click();
          } else {
            const chooser = page.waitForEvent("filechooser");
            await modal.locator(".import-drop-zone").click();
            await (await chooser).setFiles({ name: artifact.fileName, mimeType: "application/json", buffer: Buffer.from(artifact.saved) });
          }
        };

        // A clipping template must be rejected by the Properties importer.
        const beforeErrors = errors.length;
        await page.locator("#import-types-btn").click();
        await importJson(template, mode);
        await expect.poll(() => errors.slice(beforeErrors).some((message) => message.includes('"types" property not found'))).toBe(true);
        await page.locator("#import-modal .import-cancel-btn").click();

        const templateCount = (await storage()).template_list.length;
        await page.locator("#import-types-btn").click();
        await importJson(properties, mode);
        await expect(page.locator("#import-modal")).not.toBeVisible();
        const stored = await storage();
        expect(Object.fromEntries(stored.property_types.map(({ name, type }) => [name, type]))).toMatchObject({
          type: "text", source: "text", schema_version: "number", author: "text", authors: "multitext", tags: "multitext", clipper_template: "text",
        });
        expect(stored.template_list).toHaveLength(templateCount);

        await page.locator("#new-template-btn").click();
        const before = (await storage()).template_list.length;
        await page.locator(".import-template-btn:visible").click();
        await importJson(template, mode);
        await expect.poll(async () => (await storage()).template_list.length).toBe(before + 1);
        await expect(page.locator("#template-name")).toHaveValue("Companion: article");
      } finally { await context.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

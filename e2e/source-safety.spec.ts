import { readFile } from "node:fs/promises";
import type { App } from "obsidian";
import type { SourceEnrichmentController } from "../src/sources/controller";
import { expect, test } from "./fixtures";

test("Manual only permits explicit CSV enrichment without overwriting notes or sidecar annotations", async ({ rig }) => {
  const original = "# Sales\n\nUser-owned notes and annotations.\n";
  const harness = await rig.reset({
    extraFiles: { "Clippings/sales.csv": "date,units\n2024,10", "Clippings/Sales.md": original },
    settingsOverride: { sourceCaptureEnabled: true, sourceCaptureConsent: "deny", sourceEnrichOnCreate: false, semanticEnabled: false },
    providerReply: [{ match: ".", replies: [JSON.stringify({ title: "Sales", summary: "Monthly sales." })] }],
  });
  const { page } = harness;
  const datasets = () => page.evaluate(async () => {
    const app = (window as unknown as { app: App }).app;
    const paths: string[] = [];
    for (const file of app.vault.getMarkdownFiles()) if ((await app.vault.read(file)).includes('asset: "Clippings/sales.csv"')) paths.push(file.path);
    return paths;
  });
  try {
    await page.evaluate(async () => { await (window as unknown as { app: App }).app.commands.executeCommandById("claude-companion:open-source-inbox"); });
    const inbox = page.locator(".cc-inbox-view:visible").first();
    expect(await harness.providerRequests()).toBe(0);
    await inbox.getByRole("button", { name: "Enrich sales", exact: true }).click();
    await expect.poll(datasets).toHaveLength(1);
    expect(await readFile(`${harness.paths.vault}/Clippings/Sales.md`, "utf8")).toBe(original);
    const path = (await datasets())[0]!;
    await page.evaluate(async (path) => {
      const app = (window as unknown as { app: App }).app;
      const file = app.vault.getFileByPath(path)!;
      await app.vault.modify(file, (await app.vault.read(file)) + "\nUSER ANNOTATION\n");
    }, path);
    const annotated = await readFile(`${harness.paths.vault}/${path}`, "utf8");
    await harness.control.setStubs({ providerReply: [{ match: ".", replies: [JSON.stringify({ title: "A changed title", summary: "Another summary." })] }] });
    // Processed assets leave the Inbox; repeat through the public source controller.
    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: App & { plugins: { plugins: Record<string, { enrichment(): SourceEnrichmentController }> } } }).app;
      const file = app.vault.getFileByPath("Clippings/sales.csv")!;
      await app.vault.modify(file, "date,units\n2024,10\n2025,20");
      return app.plugins.plugins["claude-companion"]!.enrichment().runEnrich(file, false);
    });
    expect(result).toMatchObject({ status: "enriched" });
    expect(await harness.providerRequests()).toBe(1);
    expect(await datasets()).toEqual([path]);
    expect(await readFile(`${harness.paths.vault}/${path}`, "utf8")).toContain("rows: 2");
    expect((await readFile(`${harness.paths.vault}/${path}`, "utf8")).split("---").slice(2).join("---")).toBe(annotated.split("---").slice(2).join("---"));
    expect(await readFile(`${harness.paths.vault}/Clippings/Sales.md`, "utf8")).toBe(original);
  } finally { await harness.close(); }
});

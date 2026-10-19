import { expect, test } from "./fixtures";

test("an immediate editor correction can be enriched and resolves the failed batch", async ({ rig }, testInfo) => {
  const badPath = "Clippings/Bad clipping.md";
  const malformed = "---\nsource: https://example.com/follow-up\nwith: invalid: YAML\n---\n# Follow-up\n\nRecruit more participants before drawing conclusions.\n";
  const { page } = await rig.reset({
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" },
    extraFiles: {
      [badPath]: malformed,
      "Clippings/Good clipping.md": "---\nsource: https://example.com/pilot\n---\n# Pilot\n\nFour participants tried a checklist.\n",
    },
    providerReply: [{ match: ".", replies: [JSON.stringify({ title: "Pilot study notes", site: "Example", summary: "Small sample. Follow up before conclusions." })] }],
  });
  const read = (path: string) => page.evaluate(async (path) => {
    const app = (window as unknown as { app: { vault: { adapter: { read(path: string): Promise<string> } } } }).app;
    return app.vault.adapter.read(path);
  }, path);
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  await inbox.getByRole("button", { name: "Enrich all", exact: true }).click();
  await expect(inbox.locator(".cc-inbox-enrichment-error")).toContainText("Invalid YAML properties");
  await expect(inbox.locator(".cc-inbox-typed-count")).toHaveText("1 enriched");
  expect(await read(badPath)).toBe(malformed);
  expect(await rig.providerRequests()).toBe(1);
  const bad = inbox.locator(".cc-inbox-row").filter({ hasText: "Bad clipping" });
  await bad.locator(".cc-inbox-open").click();
  const editor = page.locator(".markdown-source-view:visible .cm-content");
  await editor.click();
  await editor.press("Meta+ArrowUp");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("Meta+ArrowLeft");
  await editor.press("Meta+Shift+ArrowRight");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("with: invalid: YAML");
  await editor.press("Backspace");
  // Do not wait for autosave: the explicit action must save the matching editor.
  await bad.getByRole("button", { name: "Enrich Bad clipping", exact: true }).click();
  await expect(inbox.locator(".cc-inbox-typed-count")).toHaveText("2 enriched");
  await expect(inbox.locator(".cc-inbox-count")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { snapshot(): { records: Array<{ id: string; state: string }> } } }> } } }).app.plugins.plugins["claude-companion"]!;
    return plugin.activity.snapshot().records.find((r) => r.id === "source-enrichment:inbox-batch")?.state;
  })).not.toBe("needs-attention");
  await expect(inbox.getByText("Needs attention", { exact: true })).toHaveCount(0);
  const saved = await read(badPath);
  expect(saved).not.toContain("with: invalid: YAML");
  expect(saved).toContain("source_enriched: true");
  expect(saved).toContain("Recruit more participants before drawing conclusions.");
  expect(saved).toContain("https://example.com/follow-up");
  expect(await rig.providerRequests()).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("recovered-inbox-without-stale-failure.png") });
});

import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  workspace: { getLeavesOfType(type: string): Array<{ detach(): void }> };
  vault: { adapter: { read(path: string): Promise<string> } };
} };

for (const failed of [false, true]) {
  test(`reopened Inbox retains its running batch and ${failed ? "failed note feedback" : "completion"}`, async ({ rig }, info) => {
    const invalid = "---\nsource: https://example.com/first\nwith: invalid: YAML\n---\n# First\n\nFour participants tried a checklist.\n";
    const { page } = await rig.reset({
      settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" },
      extraFiles: {
        "Clippings/First.md": failed ? invalid : "---\nsource: https://example.com/first\n---\n# First\n\nFour participants tried a checklist.\n",
        "Clippings/Second.md": "---\nsource: https://example.com/second\n---\n# Second\n\nRecruit more participants before drawing conclusions.\n",
      },
      providerDelayMs: 2000,
      providerReply: [{ match: "/./", replies: [JSON.stringify({ title: "Archive study notes", site: "Example", summary: "Small sample. Follow up before conclusions." })] }],
    });
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.evaluate(async () => { await (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:open-source-inbox"); });
      const inbox = page.locator(".cc-inbox-view:visible").first();
      await inbox.getByRole("button", { name: "Enrich all", exact: true }).click();
      await expect.poll(() => rig.providerRequests()).toBe(1);
      await page.evaluate(async () => {
        const app = (window as unknown as AppWindow).app;
        for (const leaf of app.workspace.getLeavesOfType("claude-inbox-view")) leaf.detach();
        await app.commands.executeCommandById("claude-companion:open-source-inbox");
      });
      await expect(inbox.locator(".cc-inbox-operation-running")).toContainText("Enriching");
      await expect(inbox.getByRole("button", { name: "Enrich all", exact: true })).toBeDisabled();
      await expect(inbox.locator(".cc-inbox-enrichment-running").first()).toBeVisible();
      await inbox.screenshot({ path: info.outputPath("reopened-inbox-retains-batch.png") });
      await expect(inbox.locator(".cc-inbox-typed-count")).toHaveText(`${failed ? 1 : 2} enriched`);
      if (failed) {
        await expect(inbox.locator(".cc-inbox-operation-error")).toContainText("needs attention");
        await expect(inbox.locator(".cc-inbox-enrichment-error")).toContainText("Invalid YAML properties");
        await expect(inbox.getByRole("button", { name: "Enrich all", exact: true })).toBeEnabled();
        expect(await page.evaluate(() => (window as unknown as AppWindow).app.vault.adapter.read("Clippings/First.md"))).toBe(invalid);
      } else await expect(inbox.locator(".cc-inbox-operation-success")).toHaveText("Typed 2 source notes.");
      expect(await rig.providerRequests()).toBe(failed ? 1 : 2);
      expect(errors).toEqual([]);
      await inbox.screenshot({ path: info.outputPath("reopened-inbox-batch-result.png") });
    } finally { page.off("pageerror", onError); }
  });
}

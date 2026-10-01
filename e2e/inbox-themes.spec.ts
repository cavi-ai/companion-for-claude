import { expect, test } from "./fixtures";

test("the Inbox offers Find research themes after Organize has emptied it", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" },
    extraFiles: {
      "Library/ai/Filed clip.md": "---\ntitle: Filed clip\ntype: article\nsource_enriched: true\n---\n# Filed clip\n\nBody.\n",
    },
  });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } })
      .app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  await expect(inbox.locator(".cc-inbox-themes .cc-eyebrow")).toHaveText("RESEARCH THEMES");
  await expect(inbox.locator(".cc-inbox-themes-run")).toHaveText("Find research themes…");
  await expect(inbox.locator(".cc-inbox-themes-run")).toBeEnabled();
});

import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
for (const move of ["file", "folder", "running"] as const) {
  test(`Regenerate follows a ${move} image rename and preserves it after reload`, async ({ rig }, testInfo) => {
    const oldPath = move === "folder" ? "Charts/ChartBefore.png" : "ChartBefore.png";
    const newPath = move === "folder" ? "Figures/ChartBefore.png" : "ChartAfter.png";
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerDelayMs: move === "running" ? 1000 : 0,
      providerReply: [{ match: String.raw`/"type"\s*:\s*"image"/`, replies: ["Chart received."] }, { match: "/./", replies: ["No image."] }],
    });
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.evaluate(async ({ png, oldPath }) => {
        const app = (window as unknown as { app: { vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown>; createFolder(path: string): Promise<unknown> }; commands: { executeCommandById(id: string): void } } }).app;
        if (oldPath.includes("/")) await app.vault.createFolder("Charts");
        await app.vault.createBinary(oldPath, Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer);
        app.commands.executeCommandById("claude-companion:new-chat-tab");
      }, { png: PNG, oldPath });
      const chat = page.locator(".cc-chat-root");
      const input = chat.locator(".cc-input");
      await input.fill("@ChartBefore");
      await expect(chat.locator(".cc-at-item.is-selected")).toContainText("ChartBefore");
      await input.press("Enter");
      await input.fill("Explain this chart.");
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      if (move === "running") await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
      else await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
      await page.evaluate(async ({ oldPath, newPath, folder }) => {
        const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown }; fileManager: { renameFile(file: unknown, path: string): Promise<void> } } }).app;
        await app.fileManager.renameFile(app.vault.getAbstractFileByPath(folder ? "Charts" : oldPath), folder ? "Figures" : newPath);
      }, { oldPath, newPath, folder: move === "folder" });
      const movedItem = move === "folder" ? '.nav-folder-title[data-path="Figures"]' : `.nav-file-title[data-path="${newPath}"]`;
      await expect(page.locator(movedItem)).toBeVisible();
      await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
      await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
      await expect.poll(() => rig.providerRequests()).toBe(2);
      await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Chart received.");
      const refs = await page.evaluate(() => {
        const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, ClaudeCompanionPlugin> } } }).app.plugins.plugins["claude-companion"]!;
        return plugin.conversations().getActive()?.messages[0]?.media?.map(({ path }) => path);
      });
      expect(refs).toEqual([newPath]);
      await rig.reloadPlugin();
      await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
      await expect.poll(() => rig.providerRequests()).toBe(3);
      await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Chart received.");
      await page.screenshot({ path: testInfo.outputPath("renamed-original-image-regenerates-after-reload.png") });
      expect(errors).toEqual([]);
    } finally { page.off("pageerror", onError); }
  });

}

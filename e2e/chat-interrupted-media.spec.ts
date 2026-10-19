import { expect, test } from "./fixtures";
import type { ChatView } from "../src/view/ChatView";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type W = Window & { app: { commands: { executeCommandById(id: string): void }; workspace: { getLeavesOfType(type: string): Array<{ view: ChatView }> }; vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown> } } };
test("an interrupted draft image survives reopening and requires reattachment before sending", async ({ rig }, info) => {
  const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } }, providerReply: [{ match: PNG, replies: ["Reattached image received."] }] });
  const errors: string[] = [], onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.evaluate(() => { (window as unknown as W).app.commands.executeCommandById("claude-companion:new-chat-tab"); });
    await page.evaluate(async () => {
      const app = (window as unknown as W).app;
      const view = app.workspace.getLeavesOfType("claude-companion-chat")[0]!.view;
      await view.setState({ conversationId: null, drafts: [{ conversationId: null, text: "Explain my interrupted chart." }], context: { media: [{ kind: "image", label: "Interrupted.png", error: "Image attachment was interrupted. Paste or attach it again." }] } }, {});
    });
    const chat = page.locator(".cc-chat-root"), input = chat.locator(".cc-input");
    await expect(input).toHaveValue("Explain my interrupted chart.");
    await page.evaluate(() => { (window as unknown as W).app.commands.executeCommandById("workspace:close"); });
    await expect(chat).toHaveCount(0);
    await page.evaluate(() => { (window as unknown as W).app.commands.executeCommandById("workspace:undo-close-pane"); });
    await rig.reloadPlugin();
    await expect(input).toHaveValue("Explain my interrupted chart.");
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Interrupted.png");
    await expect(context).toContainText("Image attachment was interrupted");
    await expect(context.getByRole("button", { name: "Retry Interrupted.png", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("interrupted-image-restored-with-question.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "Request not sent" }).last()).toContainText("interrupted");
    await expect(input).toHaveValue("Explain my interrupted chart.");
    expect(await rig.providerRequests()).toBe(0);
    await chat.locator(".cc-context-trigger").click();
    await context.getByRole("button", { name: "Remove Interrupted.png", exact: true }).click();
    await context.getByRole("button", { name: "Close message context" }).click();
    await page.evaluate(async png => { await (window as unknown as W).app.vault.createBinary("RecoveryChart.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer); }, PNG);
    await input.fill("@RecoveryChart");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("RecoveryChart");
    await input.press("Enter");
    await input.fill("Explain my interrupted chart.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Reattached image received.");
    expect(await rig.providerRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); }
});

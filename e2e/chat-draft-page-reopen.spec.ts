import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";

const URL = "https://example.test/article";
const BODY = "DRAFT-PAGE-EXCERPT-603";
type Gate = { calls: number; release(): void; restore(): void };
type TestWindow = Window & {
  app: { commands: { executeCommandById(id: string): void }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } };
  draftCaptureGate?: Gate;
};
let errors: string[] = [];
const onError = (error: Error) => errors.push(error.message);
test.beforeEach(async ({ rig }) => { errors = []; rig.page.on("pageerror", onError); });
test.afterEach(async ({ rig }) => { rig.page.off("pageerror", onError); expect(errors).toEqual([]); });

for (const pending of [false, true]) {
  test(`Undo close tab restores a ${pending ? "pending" : "ready"} selected page with its question`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerReply: [{ match: BODY, replies: ["The saved article excerpt arrived."] }],
    });
    await page.evaluate(({ pending, body }) => {
      const win = window as unknown as TestWindow;
      const plugin = win.app.plugins.plugins["claude-companion"]!;
      const original = plugin.captureWebPage;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const gate: Gate = { calls: 0, release, restore: () => { plugin.captureWebPage = original; } };
      win.draftCaptureGate = gate;
      plugin.captureWebPage = () => async () => {
        gate.calls++;
        if (pending) await waiting;
        return { title: "Selected article", markdown: body };
      };
      win.app.commands.executeCommandById("claude-companion:new-chat-tab");
    }, { pending, body: BODY });
    try {
      const command = (id: string) => page.evaluate((value) => (window as unknown as TestWindow).app.commands.executeCommandById(value), id);
      const chat = page.locator(".cc-chat-root");
      const input = chat.locator(".cc-input");
      await input.fill(`Summarize ${URL}`);
      await chat.locator(".cc-page-offer-btn").click();
      await chat.locator(".cc-context-trigger").click();
      const context = chat.getByRole("dialog", { name: "Message context" });
      await expect(context).toContainText(pending ? "Pending capture" : "Selected article");
      await context.getByRole("button", { name: "Close message context" }).click();
      await input.fill("Summarize the selected article.");
      await page.screenshot({ path: testInfo.outputPath("page-draft-before-close.png") });
      await command("workspace:close");
      await expect(chat).toHaveCount(0);
      await command("workspace:undo-close-pane");
      await expect(input).toHaveValue("Summarize the selected article.");
      await chat.locator(".cc-context-trigger").click();
      await page.screenshot({ path: testInfo.outputPath("page-draft-after-reopen.png") });
      await expect(context).toContainText(pending ? "interrupted" : "Selected article");
      if (pending) {
        expect(await page.evaluate(() => (window as unknown as TestWindow).draftCaptureGate?.calls)).toBe(1);
        await page.evaluate(() => { (window as unknown as TestWindow).draftCaptureGate?.release(); });
        await expect(context).toContainText("interrupted");
        await context.getByRole("button", { name: "Retry example.test/article", exact: true }).click();
        await expect(context).toContainText("Selected article");
        expect(await page.evaluate(() => (window as unknown as TestWindow).draftCaptureGate?.calls)).toBe(2);
      }
      await context.getByRole("button", { name: "Close message context" }).click();
      if (!pending) {
        await rig.reloadPlugin();
        await expect(input).toHaveValue("Summarize the selected article.");
        await chat.locator(".cc-context-trigger").click();
        await expect(context).toContainText("Selected article");
        await context.getByRole("button", { name: "Close message context" }).click();
      }
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The saved article excerpt arrived.");
      expect(await rig.providerRequests()).toBe(1);
    } finally {
      await page.evaluate(() => { const gate = (window as unknown as TestWindow).draftCaptureGate; gate?.release(); gate?.restore(); });
    }
  });
}

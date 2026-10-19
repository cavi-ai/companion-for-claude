import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import type ClaudeCompanionPlugin from "../src/main";

const URL = "https://example.test/article";
const BODY = "CAPTURED-PAGE-CONTENT-581";
const LATER = "REPLACEMENT-PAGE-CONTENT-582";
type Gate = { entered: boolean; calls: number; release(): void; restore(): void };
type TestWindow = Window & {
  app: { commands: { executeCommandById(id: string): void }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } };
  pageCaptureGate?: Gate;
  pageTurnGate?: { entered: boolean; release?(): void; restore(): void };
};
let errors: string[] = [];
const onError = (error: Error) => errors.push(error.message);
test.beforeEach(async ({ rig }) => { errors = []; rig.page.on("pageerror", onError); });
test.afterEach(async ({ rig }) => { rig.page.off("pageerror", onError); expect(errors).toEqual([]); });

async function installCapture(page: Page, mode: "pending" | "failed" | "empty" | "ready"): Promise<void> {
  await page.evaluate(({ mode, body, later }) => {
    const win = window as unknown as TestWindow;
    const plugin = win.app.plugins.plugins["claude-companion"]!;
    const original = plugin.captureWebPage;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const gate: Gate = { entered: false, calls: 0, release, restore: () => { plugin.captureWebPage = original; } };
    win.pageCaptureGate = gate;
    plugin.captureWebPage = () => async () => {
      gate.entered = true;
      gate.calls++;
      if (mode === "pending") await waiting;
      if (mode === "failed" && gate.calls === 1) throw new Error("Page capture failed.");
      if (mode === "empty") return { markdown: " \n " };
      return { title: "Selected article", markdown: mode === "ready" && gate.calls > 1 ? later : body };
    };
    win.app.commands.executeCommandById("claude-companion:open-chat");
  }, { mode, body: BODY, later: LATER });
}
async function cleanup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    win.pageCaptureGate?.release();
    win.pageCaptureGate?.restore();
    win.pageTurnGate?.release?.();
    win.pageTurnGate?.restore();
  });
}

for (const mode of ["pending", "failed", "empty"] as const) {
  test(`a ${mode} selected page preserves the question and supports recovery`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerReply: [{ match: BODY, replies: ["The article arrived."] }, { match: "/./", replies: ["Explicit text-only request."] }],
    });
    await installCapture(page, mode);
    try {
      const chat = page.locator(".cc-chat-root");
      const input = chat.locator(".cc-input");
      const question = `Summarize ${URL}`;
      await input.fill(question);
      await chat.locator(".cc-page-offer-btn").click();
      await page.waitForFunction(() => (window as unknown as TestWindow).pageCaptureGate?.entered);
      await chat.locator(".cc-context-trigger").click();
      const context = chat.getByRole("dialog", { name: "Message context" });
      await expect(context).toContainText(mode === "pending" ? "Pending capture" : mode === "failed" ? "Page capture failed" : "No readable content");
      await context.getByRole("button", { name: "Close message context" }).click();
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect(page.locator(".notice").filter({ hasText: "Request not sent" })).toContainText(URL);
      await expect(input).toHaveValue(question);
      expect(await rig.providerRequests()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as TestWindow).pageCaptureGate?.calls)).toBe(1);
      await page.screenshot({ path: testInfo.outputPath("unavailable-page-question-retained.png") });
      await chat.locator(".cc-context-trigger").click();
      if (mode === "empty") {
        await context.getByRole("button", { name: `Remove example.test/article`, exact: true }).click();
      } else {
        if (mode === "pending") await page.evaluate(() => { (window as unknown as TestWindow).pageCaptureGate?.release(); });
        else await context.getByRole("button", { name: "Retry example.test/article", exact: true }).click();
        await expect(context).toContainText("Selected article");
      }
      await context.getByRole("button", { name: "Close message context" }).click();
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect(chat.locator(".cc-assistant .cc-body")).toHaveText(mode === "empty" ? "Explicit text-only request." : "The article arrived.");
      expect(await rig.providerRequests()).toBe(1);
    } finally { await cleanup(page); }
  });
}

test("removing a page after Send preserves that request's captured content", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [{ match: LATER, replies: ["Replacement article."] }, { match: BODY, replies: ["Original article."] }],
  });
  await installCapture(page, "ready");
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill(`Summarize ${URL}`);
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Selected article");
    await context.getByRole("button", { name: "Close message context" }).click();
    await page.evaluate(() => {
      const win = window as unknown as TestWindow;
      const router = win.app.plugins.plugins["claude-companion"]!.router();
      const original = router.chatToolCapable;
      const gate = { entered: false, release: undefined as (() => void) | undefined, restore: () => { router.chatToolCapable = original; } };
      win.pageTurnGate = gate;
      router.chatToolCapable = async () => {
        gate.entered = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
        return original.call(router);
      };
    });
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await page.waitForFunction(() => (window as unknown as TestWindow).pageTurnGate?.entered);
    await chat.locator(".cc-context-trigger").click();
    await context.getByRole("button", { name: "Remove Selected article", exact: true }).click();
    await context.getByRole("button", { name: "Close message context" }).click();
    await page.evaluate(() => { const gate = (window as unknown as TestWindow).pageTurnGate; gate?.release?.(); gate?.restore(); });
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("Original article.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill(`Use the replacement page ${URL}`);
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Selected article");
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Replacement article.");
    expect(await rig.providerRequests()).toBe(2);
  } finally { await cleanup(page); }
});

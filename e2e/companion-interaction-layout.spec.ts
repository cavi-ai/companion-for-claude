import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openChat(page: Page): Promise<Locator> {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root:visible").first();
  await expect(chat).toBeVisible();
  return chat;
}

async function width(chat: Locator, value: number): Promise<void> {
  await chat.evaluate((root, paneWidth) => {
    const pane = root.closest(".workspace-split.mod-right-split") ?? root.closest(".workspace-leaf")?.parentElement;
    if (!(pane instanceof HTMLElement)) throw new Error("Companion pane container not found");
    Object.assign(pane.style, { width: `${paneWidth}px`, minWidth: `${paneWidth}px`, maxWidth: `${paneWidth}px`, flex: `0 0 ${paneWidth}px`, position: "fixed", inset: "0 0 0 auto", zIndex: "20" });
  }, value);
}

async function bounded(chat: Locator, selector: string): Promise<void> {
  await expect.poll(() => chat.evaluate((root, panelSelector) => {
    const panel = root.querySelector(panelSelector)!.getBoundingClientRect();
    const pane = root.getBoundingClientRect();
    const header = root.querySelector(".cc-header")!.getBoundingClientRect();
    const feedback = root.querySelector(".cc-feedback-host")!.getBoundingClientRect();
    const composer = root.querySelector(".cc-composer")!.getBoundingClientRect();
    return panel.left >= pane.left + 7 && panel.right <= pane.right - 7
      && panel.top >= Math.max(header.bottom, feedback.bottom) + 3
      && panel.bottom <= composer.top - 7 && panel.height > 44;
  }, selector)).toBe(true);
}

test("pane surfaces keep bounds, state and focus while feedback and pane size change", async ({ rig }) => {
  const harness = await rig.reset(); const { page } = harness;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(async () => {
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { conversations(): { beginTurn(id: null, messages: unknown[], input: unknown): Promise<{ conversationId: string; turnId: string }>; completeTurn(id: string, turnId: string, messages: unknown[]): Promise<void> } }> } } }).app.plugins.plugins["claude-companion"]!;
      const messages = [{ role: "user", content: "Research session" }, { role: "assistant", content: "Saved answer" }];
      const turn = await plugin.conversations().beginTurn(null, messages.slice(0, 1), { backend: "anthropic", model: "stub", mode: "ask" });
      await plugin.conversations().completeTurn(turn.conversationId, turn.turnId, messages);
    });
    const chat = await openChat(page);
    await page.evaluate(() => {
      type Plugin = { activity: { start(input: unknown): string; fail(id: string, update: unknown): void }; semantic(): { deps: { notice(message: string, duration: number): unknown } } };
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, Plugin> } } }).app.plugins.plugins["claude-companion"]!;
      const id = plugin.activity.start({ id: "layout-recovery", kind: "semantic-index", title: "Building the research index with a long activity title", total: 4 });
      plugin.activity.fail(id, { failed: 1, technicalDetails: "The local model is unavailable", recovery: [{ id: "retry-index", label: "Retry index", kind: "retry" }] });
      plugin.semantic().deps.notice("Feedback stays below the complete header.", 0);
    });
    const feedback = chat.locator(".cc-feedback-host .notice");
    await expect(feedback).toBeVisible();
    const trigger = chat.locator(".cc-activity-indicator");
    await expect(trigger).toHaveText(/Activity/);
    await expect(trigger).not.toContainText("Building the research index");
    for (const paneWidth of [280, 320, 360, 420, 600, 768]) {
      await width(chat, paneWidth);
      await chat.locator(".cc-sessions-btn").click();
      const sessions = chat.locator(".cc-session-dropdown");
      await expect(sessions).toBeVisible(); await bounded(chat, ".cc-session-dropdown");
      await sessions.getByRole("textbox", { name: "Search sessions" }).fill("retained query");
      await width(chat, paneWidth === 280 ? 320 : 280);
      await bounded(chat, ".cc-session-dropdown");
      await expect(sessions.getByRole("textbox", { name: "Search sessions" })).toHaveValue("retained query");
      await expect(sessions.getByRole("textbox", { name: "Search sessions" })).toBeFocused();
      await trigger.click();
      await expect(sessions).toHaveCount(0);
      const drawer = chat.locator(".cc-activity-drawer");
      await bounded(chat, ".cc-activity-drawer");
      await drawer.getByRole("button", { name: "Close activity" }).click();
      await expect(trigger).toBeFocused();
      await trigger.click();
      const input = chat.locator("textarea.cc-input"); await input.click();
      await expect(drawer).toHaveCount(0); await expect(input).toBeFocused();
      await chat.locator(".cc-sessions-btn").click();
      await page.keyboard.press("Escape"); await expect(chat.locator(".cc-sessions-btn")).toBeFocused();
      await expect(feedback).toBeVisible();
    }
    await trigger.click();
    const record = chat.locator(".cc-activity-record");
    await record.locator("summary").first().click();
    await record.locator(".cc-activity-technical summary").click();
    const recovery = record.getByRole("button", { name: /^Retry index for/ }); await recovery.focus();
    await page.evaluate(() => {
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { update(id: string, change: unknown): void } }> } } }).app.plugins.plugins["claude-companion"]!;
      plugin.activity.update("layout-recovery", { currentItem: "Next file" });
    });
    await expect(record).toHaveAttribute("open", ""); await expect(record.locator(".cc-activity-technical")).toHaveAttribute("open", "");
    await expect(recovery).toBeFocused();
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    await feedback.getByRole("button", { name: "Dismiss feedback" }).focus();
    await page.keyboard.press("Enter"); await expect(feedback).toHaveCount(0);
  } finally { await harness.close(); }
});


test("keyboard dismissal of the final activity returns focus to its chat composer", async ({ rig }, testInfo) => {
  const harness = await rig.reset(); const { page } = harness;
  try {
    const chat = await openChat(page); const input = chat.locator("textarea.cc-input");
    await input.fill("Continue after checking activity");
    await page.evaluate(() => {
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { start(input: unknown): string; fail(id: string, update: unknown): void } }> } } }).app.plugins.plugins["claude-companion"]!;
      const id = plugin.activity.start({ id: "final-focus", kind: "semantic-index", title: "Final index", total: 1 });
      plugin.activity.fail(id, { failed: 1 });
    });
    const trigger = chat.locator(".cc-activity-indicator"); await trigger.focus(); await page.keyboard.press("Enter");
    const drawer = chat.locator(".cc-activity-drawer"); await expect(drawer).toBeVisible();
    const summary = drawer.locator(".cc-activity-summary"); await summary.focus(); await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    const dismiss = drawer.getByRole("button", { name: "Dismiss Final index activity", exact: true });
    await expect(dismiss).toBeFocused(); await page.keyboard.press("Enter");
    await expect(drawer).toHaveCount(0); await expect(trigger).toHaveCount(0);
    await expect(input).toBeFocused(); await expect(input).toHaveValue("Continue after checking activity");
    await page.screenshot({ path: testInfo.outputPath("final-activity-dismiss-focus.png") });
  } finally { await harness.close(); }
});

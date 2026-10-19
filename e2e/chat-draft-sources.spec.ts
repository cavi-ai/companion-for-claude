import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
const PNG_PATTERN = PNG.replaceAll("+", "[+]");
type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> }; vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown> } }; captureGate?: { calls: number; release(): void; restore(): void } };
test("each resumed draft uses its own selected source after reload", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Notes/AContext.md": "OWNER-A-NOTE-611", "Notes/BContext.md": "OWNER-B-NOTE-612" },
    providerReply: [
      { match: String.raw`/^(?=[\s\S]*OWNER-B-NOTE-612)(?![\s\S]*(?:OWNER-A-NOTE-611|${PNG_PATTERN}))/`, replies: ["Source B received."] },
      { match: String.raw`/^(?=[\s\S]*OWNER-A-NOTE-611)(?=[\s\S]*${PNG_PATTERN})(?![\s\S]*OWNER-B-NOTE-612)/`, replies: ["Source A received."] },
      { match: "/./", replies: ["Seed reply."] },
    ],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:new-chat-tab"));
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("Archive conversation");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill("@AContext");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("AContext");
    await input.press("Enter");
    await page.evaluate(async (png) => {
      await (window as unknown as TestWindow).app.vault.createBinary("Notes/AChart.png", Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
    }, PNG);
    await input.fill("@AChart");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("AChart");
    await input.press("Enter");
    await input.fill("Follow up on archive A.");
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await input.fill("@BContext");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("BContext");
    await input.press("Enter");
    await input.fill("New chat question B.");
    await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await page.locator(".cc-session-row").filter({ hasText: "Archive conversation" }).click();
    await expect(input).toHaveValue("Follow up on archive A.");
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Notes/AContext.md");
    await expect(context).toContainText("Notes/AChart.png");
    await expect(context).not.toContainText("Notes/BContext.md");
    await page.screenshot({ path: testInfo.outputPath("archive-draft-with-its-source.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await rig.reloadPlugin();
    await expect(input).toHaveValue("Follow up on archive A.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Source A received.");
    expect(await rig.providerRequests()).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("archive-request-received-source-a.png") });
    await chat.getByRole("button", { name: "Regenerate", exact: true }).last().waitFor();
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(input).toHaveValue("New chat question B.");
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Notes/BContext.md");
    await expect(context).not.toContainText("Notes/AContext.md");
    await expect(context).not.toContainText("AChart");
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Source B received.");
    expect(await rig.providerRequests()).toBe(3);
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); }
});

test("a capture completing in another draft stays with its original question", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Notes/BContext.md": "OWNER-B-NOTE-612" },
    providerReply: [{ match: "OWNER-B-NOTE-612", replies: ["Source B received."] }, { match: "PAGE-A-DRAFT-613", replies: ["Page A received."] }, { match: "/./", replies: ["Seed reply."] }],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    const plugin = win.app.plugins.plugins["claude-companion"]!;
    const original = plugin.captureWebPage;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const gate = { calls: 0, release, restore: () => { plugin.captureWebPage = original; } };
    win.captureGate = gate;
    plugin.captureWebPage = () => async () => { gate.calls++; await waiting; return { title: "Page A", markdown: "PAGE-A-DRAFT-613" }; };
    win.app.commands.executeCommandById("claude-companion:new-chat-tab");
  });
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("Article conversation");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill("Summarize https://example.test/article-a");
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Pending capture");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("Continue with article A.");
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await input.fill("@BContext");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("BContext");
    await input.press("Enter");
    await input.fill("Keep question B separate.");
    await page.evaluate(async () => { (window as unknown as TestWindow).captureGate?.release(); await Promise.resolve(); await Promise.resolve(); });
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Notes/BContext.md");
    await expect(context).not.toContainText("Page A");
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await page.locator(".cc-session-row").filter({ hasText: "Article conversation" }).click();
    await expect(input).toHaveValue("Continue with article A.");
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Page A");
    await expect(context).not.toContainText("BContext");
    expect(await page.evaluate(() => (window as unknown as TestWindow).captureGate?.calls)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("completed-capture-back-in-its-draft.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Page A received.");
    expect(await rig.providerRequests()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => { const gate = (window as unknown as TestWindow).captureGate; gate?.release(); gate?.restore(); });
    page.off("pageerror", onError);
  }
});

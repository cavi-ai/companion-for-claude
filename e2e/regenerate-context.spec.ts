import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";
type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } }; captureGate?: { release(): void; restore(): void } };
test("Regenerate excludes the next question's pending and ready page", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [{ match: "NEXT-QUESTION-PAGE-641", replies: ["Next page used."] }, { match: "/./", replies: ["Original answer."] }],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    const plugin = win.app.plugins.plugins["claude-companion"]!;
    const original = plugin.captureWebPage;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    win.captureGate = { release, restore: () => { plugin.captureWebPage = original; } };
    plugin.captureWebPage = () => async () => { await waiting; return { title: "Next article", markdown: "NEXT-QUESTION-PAGE-641" }; };
    win.app.commands.executeCommandById("claude-companion:new-chat-tab");
  });
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("Summarize the earlier question.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill("My next question https://example.test/next-article");
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Pending capture");
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect.poll(() => rig.providerRequests()).toBe(2);
    await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expect(input).toHaveValue("My next question https://example.test/next-article");
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original answer.");
    await page.screenshot({ path: testInfo.outputPath("next-page-capture-does-not-block-earlier-answer.png") });
    await page.evaluate(() => (window as unknown as TestWindow).captureGate?.release());
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Next article");
    await expect(context).not.toContainText("Pending capture");
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original answer.");
    await expect.poll(() => rig.providerRequests()).toBe(3);
    await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("earlier-answer-excludes-next-questions-page.png") });
    await expect(input).toHaveValue("My next question https://example.test/next-article");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Next page used.");
    expect(await rig.providerRequests()).toBe(4);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => { const gate = (window as unknown as TestWindow).captureGate; gate?.release(); gate?.restore(); });
    page.off("pageerror", onError);
  }
});

test("Regenerate restores its original notes and page after reload while preserving the next sources", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Sources/Original.md": "ORIGINAL-NOTE-642", "Sources/Queued.md": "QUEUED-NOTE-643" },
    providerReply: [
      { match: String.raw`/^(?=[\s\S]*ORIGINAL-NOTE-642)(?=[\s\S]*ORIGINAL-PAGE-644)(?![\s\S]*(?:QUEUED-NOTE-643|QUEUED-PAGE-645))/`, replies: ["Original sources only."] },
      { match: String.raw`/^(?=[\s\S]*QUEUED-NOTE-643)(?=[\s\S]*QUEUED-PAGE-645)(?![\s\S]*(?:ORIGINAL-NOTE-642|ORIGINAL-PAGE-644))/`, replies: ["Queued sources only."] },
      { match: "/./", replies: ["Wrong sources."] },
    ],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  const configureCapture = () => page.evaluate(() => {
    const win = window as unknown as TestWindow & { restoreCapture?: () => void };
    const plugin = win.app.plugins.plugins["claude-companion"]!;
    const original = plugin.captureWebPage;
    win.restoreCapture = () => { plugin.captureWebPage = original; };
    plugin.captureWebPage = () => async url => url.endsWith("original") ? { title: "Original page", markdown: "ORIGINAL-PAGE-644" } : { title: "Queued page", markdown: "QUEUED-PAGE-645" };
  });
  try {
    await configureCapture();
    await page.evaluate(() => { (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:new-chat-tab"); });
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@Original");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Original");
    await input.press("Enter");
    await input.fill("https://example.test/original");
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Original page");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("Explain my original sources.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original sources only.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown }; fileManager: { renameFile(file: unknown, path: string): Promise<void> } } }).app;
      await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Sources/Original.md"), "Sources/RenamedOriginal.md");
    });
    await rig.reloadPlugin();
    await configureCapture();
    // Replace the next draft's selection through the context UI; the accepted question retains its own references.
    await chat.locator(".cc-context-trigger").click();
    const removes = context.getByRole("button", { name: /^Remove / });
    while (await removes.count()) await removes.first().click();
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("@Queued");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Queued");
    await input.press("Enter");
    await input.fill("https://example.test/queued");
    await chat.locator(".cc-page-offer-btn").click();
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Queued page");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("My next sources question.");
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect.poll(() => rig.providerRequests()).toBe(2);
    await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original sources only.");
    await expect(input).toHaveValue("My next sources question.");
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Sources/Queued.md");
    await expect(context).toContainText("Queued page");
    await expect(context).not.toContainText("RenamedOriginal");
    await page.screenshot({ path: testInfo.outputPath("regenerate-preserves-next-notes-and-page.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Queued sources only.");
    expect(await rig.providerRequests()).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as unknown as TestWindow & { restoreCapture?: () => void }).restoreCapture?.());
    page.off("pageerror", onError);
  }
});

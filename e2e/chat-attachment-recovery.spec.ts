import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type Gate = { entered: boolean; release?(): void; restore(): void };
type TestWindow = Window & {
  app: {
    commands: { executeCommandById(id: string): void };
    vault: {
      createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
      getAbstractFileByPath(path: string): unknown;
      delete(file: unknown): Promise<void>;
    };
    fileManager: { renameFile(file: unknown, path: string): Promise<void> };
    plugins: { plugins: Record<string, ClaudeCompanionPlugin> };
  };
  attachmentGate?: Gate;
};
const settings = { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } };

for (const folder of [false, true]) {
  test(`attached image follows a ${folder ? "folder move" : "file rename"} into the request`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: settings,
      extraFiles: { "Images/Seed.md": "# Images" },
      providerReply: [{ match: PNG, replies: ["The image reached the request."] }],
    });
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.evaluate(async (png) => {
        const app = (window as unknown as TestWindow).app;
        app.commands.executeCommandById("claude-companion:open-chat");
        await app.vault.createBinary("Images/Before.png", Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
      }, PNG);
      const chat = page.locator(".cc-chat-root");
      const input = chat.locator(".cc-input");
      await input.fill("@Before");
      await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Before");
      await input.press("Enter");
      await input.fill("Explain the attached image.");
      await page.evaluate(async (moveFolder) => {
        const app = (window as unknown as TestWindow).app;
        await app.fileManager.renameFile(app.vault.getAbstractFileByPath(moveFolder ? "Images" : "Images/Before.png"), moveFolder ? "Archive" : "Images/After.png");
      }, folder);
      await chat.locator(".cc-context-trigger").click();
      const context = chat.getByRole("dialog", { name: "Message context" });
      await expect(context).toContainText(folder ? "Archive/Before.png" : "Images/After.png");
      await expect(context).not.toContainText("Images/Before.png");
      await page.screenshot({ path: testInfo.outputPath("renamed-attachment-before-send.png") });
      await context.getByRole("button", { name: "Close message context" }).click();
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The image reached the request.");
      expect(await rig.providerRequests()).toBe(1);
      expect(errors).toEqual([]);
    } finally { page.off("pageerror", onError); }
  });
}

test("an unavailable image preserves the question until the file is restored", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: settings, providerReply: [{ match: PNG, replies: ["The restored image arrived."] }] });
  await page.evaluate(async (png) => {
    const app = (window as unknown as TestWindow).app;
    app.commands.executeCommandById("claude-companion:open-chat");
    await app.vault.createBinary("Chart.png", Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
  }, PNG);
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  await input.fill("@Chart");
  await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Chart");
  await input.press("Enter");
  await input.fill("  Explain this image.  ");
  await page.evaluate(async () => {
    const app = (window as unknown as TestWindow).app;
    await app.vault.delete(app.vault.getAbstractFileByPath("Chart.png"));
  });
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(page.locator(".notice").filter({ hasText: "Request not sent" })).toContainText("Reattach");
  await expect(input).toHaveValue("  Explain this image.  ");
  expect(await rig.providerRequests()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("unavailable-attachment-question-retained.png") });
  await page.evaluate(async (png) => {
    await (window as unknown as TestWindow).app.vault.createBinary("Chart.png", Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
  }, PNG);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The restored image arrived.");
  expect(await rig.providerRequests()).toBe(1);
});

test("an image pasted during preparation stays attached to the next message", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: settings,
    providerReply: [{ match: PNG, replies: ["Image request."] }, { match: "/./", replies: ["Text request."] }],
  });
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    win.app.commands.executeCommandById("claude-companion:open-chat");
    const router = win.app.plugins.plugins["claude-companion"]!.router();
    const original = router.chatToolCapable;
    const gate: Gate = { entered: false, restore: () => { router.chatToolCapable = original; } };
    win.attachmentGate = gate;
    router.chatToolCapable = async () => {
      if (!gate.entered) {
        gate.entered = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      return original.call(router);
    };
  });
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("Explain a concept first.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await page.waitForFunction(() => (window as unknown as TestWindow).attachmentGate?.entered);
    await input.evaluate((element, png) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "Late.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG);
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Late.png");
    await context.getByRole("button", { name: "Close message context" }).click();
    await page.evaluate(() => { (window as unknown as TestWindow).attachmentGate?.release?.(); });
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("Text request.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Late.png");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("Now explain this image.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Image request.");
    expect(await rig.providerRequests()).toBe(2);
  } finally {
    await page.evaluate(() => {
      const gate = (window as unknown as TestWindow).attachmentGate;
      gate?.release?.();
      gate?.restore();
    });
  }
});

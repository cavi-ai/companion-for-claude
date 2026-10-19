import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";

type TestWindow = Window & {
  app: {
    commands: { executeCommandById(id: string): void };
    vault: {
      getConfig(key: string): unknown;
      setConfig(key: string, value: unknown): void;
      getAbstractFileByPath(path: string): unknown;
      readBinary(file: unknown): Promise<ArrayBuffer>;
      createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
    };
  };
  restoreAttachmentWrite?(): void;
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
async function paste(input: Locator, name: string): Promise<void> {
  await input.evaluate((element, args) => {
    const bytes = Uint8Array.from(atob(args.png), (c) => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], args.name, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, { png: PNG, name });
}

test("pasted image bytes use the configured attachment folder and reach the request", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false }, providerReply: [{ match: PNG, replies: ["Image received."] }] });
  const oldFolder = await page.evaluate(() => String((window as unknown as TestWindow).app.vault.getConfig("attachmentFolderPath") ?? "/"));
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.evaluate(() => {
      const app = (window as unknown as TestWindow).app;
      app.vault.setConfig("attachmentFolderPath", "Draft attachments");
      app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("Describe this chart.");
    await paste(input, "pasted-chart.png");
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Draft attachments/pasted-chart.png");
    expect(await page.evaluate(async () => {
      const app = (window as unknown as TestWindow).app;
      const bytes = await app.vault.readBinary(app.vault.getAbstractFileByPath("Draft attachments/pasted-chart.png"));
      return btoa(String.fromCharCode(...new Uint8Array(bytes)));
    })).toBe(PNG);
    await page.screenshot({ path: testInfo.outputPath("configured-attachment-folder.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("Image received.");
    expect(await rig.providerRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate((value) => (window as unknown as TestWindow).app.vault.setConfig("attachmentFolderPath", value), oldFolder);
    page.off("pageerror", onError);
  }
});

test("a failed image save retains the question and permits a successful retry", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false } });
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    win.app.commands.executeCommandById("claude-companion:open-chat");
    const vault = win.app.vault;
    const original = vault.createBinary;
    win.restoreAttachmentWrite = () => { vault.createBinary = original; };
    vault.createBinary = async (path, data) => {
      if (path.endsWith("blocked-chart.png")) throw new Error("Attachment folder is read-only.");
      return original.call(vault, path, data);
    };
  });
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("My unfinished image question");
    await paste(input, "blocked-chart.png");
    await expect(page.locator(".notice").filter({ hasText: "Couldn't attach the pasted image" })).toContainText("read-only");
    await expect(input).toHaveValue("My unfinished image question");
    expect(await rig.providerRequests()).toBe(0);
    await page.evaluate(() => (window as unknown as TestWindow).restoreAttachmentWrite?.());
    await paste(input, "blocked-chart.png");
    await chat.locator(".cc-context-trigger").click();
    await expect(chat.getByRole("dialog", { name: "Message context" })).toContainText("blocked-chart.png");
    await expect(input).toHaveValue("My unfinished image question");
    await page.screenshot({ path: testInfo.outputPath("attachment-save-retried.png") });
  } finally {
    await page.evaluate(() => { const win = window as unknown as TestWindow; win.restoreAttachmentWrite?.(); delete win.restoreAttachmentWrite; });
  }
});
